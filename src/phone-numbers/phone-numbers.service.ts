import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CreatePhoneNumberDto } from "./dto/create-phone-number.dto.js";
import { UpdatePhoneNumberDto } from "./dto/update-phone-number.dto.js";

@Injectable()
export class PhoneNumbersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreatePhoneNumberDto) {
    const providerConflict = await this.prisma.whatsAppPhoneNumber.findUnique({
      where: { providerPhoneNumberId: dto.providerPhoneNumberId },
    });
    if (providerConflict) {
      throw new ConflictException("This Meta phone_number_id is already registered");
    }

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const existingActive = await transaction.whatsAppPhoneNumber.findFirst({
          where: { tenantId, active: true },
          select: { id: true },
        });
        const isDefault = dto.isDefault ?? !existingActive;

        if (isDefault) {
          await transaction.whatsAppPhoneNumber.updateMany({
            where: { tenantId, isDefault: true },
            data: { isDefault: false },
          });
        }

        return transaction.whatsAppPhoneNumber.create({
          data: {
            tenantId,
            providerPhoneNumberId: dto.providerPhoneNumberId,
            wabaId: dto.wabaId,
            displayPhoneNumber: dto.displayPhoneNumber,
            verifiedName: dto.verifiedName,
            credentialRef: dto.credentialRef,
            rateLimitPerSecond: dto.rateLimitPerSecond,
            isDefault,
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("Unable to register WhatsApp phone number because a unique sender constraint was violated");
      }
      throw error;
    }
  }

  list(tenantId: string) {
    return this.prisma.whatsAppPhoneNumber.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  }

  async findById(tenantId: string, id: string) {
    const phoneNumber = await this.prisma.whatsAppPhoneNumber.findFirst({
      where: { id, tenantId },
    });
    if (!phoneNumber) {
      throw new NotFoundException("WhatsApp phone number not found");
    }
    return phoneNumber;
  }

  async update(tenantId: string, id: string, dto: UpdatePhoneNumberDto) {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.whatsAppPhoneNumber.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        throw new NotFoundException("WhatsApp phone number not found");
      }

      const willBeActive = dto.active ?? existing.active;
      const willBeDefault = dto.isDefault ?? existing.isDefault;
      if (willBeDefault && !willBeActive) {
        throw new BadRequestException("An inactive WhatsApp phone number cannot be the default sender");
      }

      if (willBeDefault && willBeActive) {
        await transaction.whatsAppPhoneNumber.updateMany({
          where: { tenantId, id: { not: id }, isDefault: true },
          data: { isDefault: false },
        });
      }

      const updated = await transaction.whatsAppPhoneNumber.update({
        where: { id },
        data: {
          wabaId: dto.wabaId,
          displayPhoneNumber: dto.displayPhoneNumber,
          verifiedName: dto.verifiedName,
          credentialRef: dto.credentialRef,
          rateLimitPerSecond: dto.rateLimitPerSecond,
          active: dto.active,
          isDefault: dto.isDefault,
        },
      });

      const activeDefault = await transaction.whatsAppPhoneNumber.findFirst({
        where: { tenantId, active: true, isDefault: true },
        select: { id: true },
      });
      if (!activeDefault) {
        const fallback = await transaction.whatsAppPhoneNumber.findFirst({
          where: { tenantId, active: true },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
        if (fallback) {
          await transaction.whatsAppPhoneNumber.update({
            where: { id: fallback.id },
            data: { isDefault: true },
          });
        }
      }

      return transaction.whatsAppPhoneNumber.findUniqueOrThrow({ where: { id: updated.id } });
    });
  }

  async resolveForTenant(tenantId: string, senderId?: string) {
    const sender = senderId
      ? await this.prisma.whatsAppPhoneNumber.findFirst({ where: { id: senderId, tenantId, active: true } })
      : await this.prisma.whatsAppPhoneNumber.findFirst({
          where: { tenantId, active: true },
          orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        });

    if (!sender) {
      throw new UnprocessableEntityException("No active WhatsApp sender is configured for this tenant");
    }
    return sender;
  }

  async findActiveById(id: string) {
    const sender = await this.prisma.whatsAppPhoneNumber.findFirst({
      where: { id, active: true },
    });
    if (!sender) {
      throw new UnprocessableEntityException("Configured WhatsApp sender is missing or inactive");
    }
    return sender;
  }

  async findByProviderPhoneNumberId(providerPhoneNumberId: string) {
    const sender = await this.prisma.whatsAppPhoneNumber.findUnique({
      where: { providerPhoneNumberId },
    });
    if (!sender) {
      throw new UnprocessableEntityException(`Unconfigured Meta phone_number_id ${providerPhoneNumberId}`);
    }
    return sender;
  }
}
