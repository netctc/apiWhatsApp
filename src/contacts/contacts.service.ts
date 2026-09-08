import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ConsentStatus, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CreateContactDto } from "./dto/create-contact.dto.js";
import { ConsentDecision, RecordConsentDto } from "./dto/record-consent.dto.js";
import { UpdateContactDto } from "./dto/update-contact.dto.js";
import { normalizePhoneNumber } from "./phone.util.js";

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateContactDto) {
    const phone = normalizePhoneNumber(dto.phone);
    const existing = await this.prisma.contact.findUnique({
      where: { tenantId_phone: { tenantId, phone } },
    });
    if (existing) {
      throw new ConflictException("Contact already exists for this tenant");
    }

    return this.prisma.contact.create({
      data: {
        tenantId,
        phone,
        name: dto.name,
        language: dto.language,
        timezone: dto.timezone,
        metadata: dto.metadata ? this.toJson(dto.metadata) : undefined,
      },
    });
  }

  async list(tenantId: string) {
    return this.prisma.contact.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async findById(tenantId: string, id: string) {
    const contact = await this.prisma.contact.findFirst({
      where: { id, tenantId },
    });
    if (!contact) {
      throw new NotFoundException("Contact not found");
    }
    return contact;
  }

  async findByPhone(tenantId: string, phone: string) {
    return this.prisma.contact.findUnique({
      where: { tenantId_phone: { tenantId, phone: normalizePhoneNumber(phone) } },
    });
  }

  async update(tenantId: string, id: string, dto: UpdateContactDto) {
    await this.findById(tenantId, id);
    return this.prisma.contact.update({
      where: { id },
      data: {
        name: dto.name,
        language: dto.language,
        timezone: dto.timezone,
        metadata: dto.metadata ? this.toJson(dto.metadata) : undefined,
      },
    });
  }

  async recordConsent(tenantId: string, id: string, dto: RecordConsentDto) {
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    const status = dto.status === ConsentDecision.OPTED_IN
      ? ConsentStatus.OPTED_IN
      : ConsentStatus.OPTED_OUT;

    return this.prisma.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "Contact"
        WHERE "id" = ${id}::uuid
          AND "tenantId" = ${tenantId}::uuid
        FOR UPDATE
      `);
      if (locked.length === 0) {
        throw new NotFoundException("Contact not found");
      }

      const existing = await transaction.contact.findUniqueOrThrow({ where: { id } });
      const latestEvent = await transaction.contactConsentEvent.findFirst({
        where: { tenantId, contactId: id },
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      });

      const event = await transaction.contactConsentEvent.create({
        data: {
          tenantId,
          contactId: id,
          status,
          source: dto.source,
          occurredAt,
          evidence: dto.evidence ? this.toJson(dto.evidence) : undefined,
        },
      });

      const isCurrentDecision = !latestEvent || occurredAt.getTime() >= latestEvent.occurredAt.getTime();
      if (!isCurrentDecision) {
        return { contact: existing, event };
      }

      const contact = await transaction.contact.update({
        where: { id },
        data: {
          consentStatus: status,
          consentSource: dto.source,
          consentAt: status === ConsentStatus.OPTED_IN ? occurredAt : existing.consentAt,
          optedOutAt: status === ConsentStatus.OPTED_OUT ? occurredAt : null,
        },
      });

      return { contact, event };
    });
  }

  async listConsentEvents(tenantId: string, id: string) {
    await this.findById(tenantId, id);
    return this.prisma.contactConsentEvent.findMany({
      where: { tenantId, contactId: id },
      orderBy: { occurredAt: "desc" },
      take: 100,
    });
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
