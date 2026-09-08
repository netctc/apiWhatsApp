import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { formatE164PhoneNumber } from "../common/phone-number.util.js";
import { ConsentStatus, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CreateContactDto } from "./dto/create-contact.dto.js";
import { RecordConsentDto } from "./dto/record-consent.dto.js";

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface InboundContactInput {
  tenantId: string;
  phoneNumber: string;
  profileName?: string;
  receivedAt: Date;
}

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateContactDto) {
    const phoneNumber = this.normalizePhone(dto.phoneNumber);

    try {
      return await this.prisma.contact.create({
        data: {
          tenantId,
          phoneNumber,
          name: dto.name?.trim() || undefined,
          language: dto.language?.trim() || undefined,
          timezone: dto.timezone?.trim() || undefined,
          ...(dto.metadata !== undefined ? { metadata: this.toJson(dto.metadata) } : {}),
        },
      });
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        throw new ConflictException("A contact with this phone number already exists for the tenant");
      }
      throw error;
    }
  }

  async findAll(tenantId: string, phone?: string) {
    const normalizedPhone = phone ? this.normalizePhone(phone) : undefined;

    return this.prisma.contact.findMany({
      where: {
        tenantId,
        ...(normalizedPhone ? { phoneNumber: normalizedPhone } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: normalizedPhone ? 1 : 100,
    });
  }

  async findById(tenantId: string, contactId: string) {
    return this.prisma.contact.findFirst({
      where: { id: contactId, tenantId },
      include: {
        consentEvents: {
          orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
          take: 50,
        },
      },
    });
  }

  async recordConsent(tenantId: string, contactId: string, dto: RecordConsentDto) {
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, tenantId },
    });

    if (!contact) {
      throw new NotFoundException("Contact not found");
    }

    return this.prisma.$transaction(async (transaction) => {
      const event = await transaction.contactConsentEvent.create({
        data: {
          tenantId,
          contactId,
          status: dto.status,
          source: dto.source.trim(),
          ...(dto.evidence !== undefined ? { evidence: this.toJson(dto.evidence) } : {}),
          policyVersion: dto.policyVersion?.trim() || undefined,
          occurredAt,
        },
      });

      let projectedContact = contact;
      if (!contact.optInUpdatedAt || occurredAt.getTime() >= contact.optInUpdatedAt.getTime()) {
        projectedContact = await transaction.contact.update({
          where: { id: contactId },
          data: {
            optInStatus: dto.status,
            optInUpdatedAt: occurredAt,
          },
        });
      }

      return {
        contact: projectedContact,
        event,
      };
    });
  }

  async upsertFromInbound(input: InboundContactInput) {
    const phoneNumber = this.normalizePhone(input.phoneNumber);
    const serviceWindowExpiresAt = new Date(input.receivedAt.getTime() + CUSTOMER_SERVICE_WINDOW_MS);

    const existing = await this.prisma.contact.findUnique({
      where: {
        tenantId_phoneNumber: {
          tenantId: input.tenantId,
          phoneNumber,
        },
      },
    });

    if (!existing) {
      try {
        return await this.prisma.contact.create({
          data: {
            tenantId: input.tenantId,
            phoneNumber,
            name: input.profileName?.trim() || undefined,
            lastInboundAt: input.receivedAt,
            customerServiceWindowExpiresAt: serviceWindowExpiresAt,
          },
        });
      } catch (error) {
        if (!this.isUniqueConstraintViolation(error)) {
          throw error;
        }
      }
    }

    await this.prisma.contact.updateMany({
      where: {
        tenantId: input.tenantId,
        phoneNumber,
        OR: [
          { lastInboundAt: null },
          { lastInboundAt: { lte: input.receivedAt } },
        ],
      },
      data: {
        ...(input.profileName?.trim() ? { name: input.profileName.trim() } : {}),
        lastInboundAt: input.receivedAt,
        customerServiceWindowExpiresAt: serviceWindowExpiresAt,
      },
    });

    const contact = await this.prisma.contact.findUnique({
      where: {
        tenantId_phoneNumber: {
          tenantId: input.tenantId,
          phoneNumber,
        },
      },
    });

    if (!contact) {
      throw new Error("Inbound contact could not be created or reloaded");
    }

    return contact;
  }

  private normalizePhone(value: string): string {
    try {
      return formatE164PhoneNumber(value);
    } catch {
      throw new UnprocessableEntityException("Phone number must be a valid international number");
    }
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
