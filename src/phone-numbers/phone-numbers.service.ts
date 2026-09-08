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
    await this.assertWabaOwnership(tenantId, dto.wabaId);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const existingActive = await transaction.whatsAppPhoneNumber.findFirst({
          where: { tenantId, active: true },
          select: { id: true },
        });
        const isDefault = !existingActive || dto.isDefault === true;

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
    await this.assertWabaOwnership(tenantId, dto.wabaId);

    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.whatsAppPhoneNumber.findFirst({
        where: { id, tenantId },
      });
      if (!existing) {
        throw new NotFoundException("WhatsApp phone number not found");
      }

      const willBeActive = dto.active ?? existing.active;
      const requestedDefault = dto.isDefault ?? (dto.active === false ? false : existing.isDefault);
      if (dto.isDefault === true && !willBeActive) {
        throw new BadRequestException("An inactive WhatsApp phone number cannot be the default sender");
      }

      if (requestedDefault && willBeActive) {
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
          isDefault: dto.isDefault ?? (dto.active === false ? false : undefined),
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

  async resolveWabaForTenant(tenantId: string, senderId?: string) {
    const sender = await this.resolveForTenant(tenantId, senderId);
    if (!sender.wabaId) {
      throw new UnprocessableEntityException("The selected WhatsApp sender is missing its WABA ID");
    }
    return { sender, wabaId: sender.wabaId };
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

  async findTenantIdByWabaId(wabaId: string): Promise<string> {
    const owners = await this.prisma.whatsAppPhoneNumber.findMany({
      where: { wabaId },
      distinct: ["tenantId"],
      select: { tenantId: true },
      take: 2,
    });
    if (owners.length === 0) {
      throw new UnprocessableEntityException(`Unconfigured WABA ${wabaId}`);
    }
    if (owners.length > 1) {
      throw new UnprocessableEntityException(`WABA ${wabaId} is ambiguously assigned to multiple tenants`);
    }
    return owners[0]!.tenantId;
  }

  private async assertWabaOwnership(tenantId: string, wabaId?: string): Promise<void> {
    if (!wabaId) {
      return;
    }

    const conflict = await this.prisma.whatsAppPhoneNumber.findFirst({
      where: {
        wabaId,
        tenantId: { not: tenantId },
      },
      select: { tenantId: true },
    });
    if (conflict) {
      throw new ConflictException("This WABA is already associated with another tenant");
    }
  }
}
