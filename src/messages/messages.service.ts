import { ConflictException, Injectable } from "@nestjs/common";
import { normalizePhoneNumber } from "../contacts/phone.util.js";
import { MessageDirection, MessageStatus, MessageType, Prisma } from "../generated/prisma/client.js";
import { PhoneNumbersService } from "../phone-numbers/phone-numbers.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CreateMessageDto, OutboundMessageType } from "./dto/create-message.dto.js";
import { OutboundPolicyService } from "./outbound-policy.service.js";

const OUTBOUND_REQUESTED_EVENT = "message.outbound.requested";

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outboundPolicy: OutboundPolicyService,
    private readonly phoneNumbers: PhoneNumbersService,
  ) {}

  async create(tenantId: string, dto: CreateMessageDto) {
    if (dto.idempotencyKey) {
      const existing = await this.prisma.message.findFirst({
        where: { tenantId, idempotencyKey: dto.idempotencyKey },
      });

      if (existing) {
        return existing;
      }
    }

    await this.outboundPolicy.assertAllowed(tenantId, dto.to, dto.type);
    const normalizedTo = normalizePhoneNumber(dto.to);
    const sender = await this.phoneNumbers.resolveForTenant(tenantId, dto.senderId);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const message = await transaction.message.create({
          data: {
            tenantId,
            senderId: sender.id,
            direction: MessageDirection.OUTBOUND,
            type: this.mapType(dto.type),
            status: MessageStatus.QUEUED,
            to: normalizedTo,
            idempotencyKey: dto.idempotencyKey,
            payload: this.toJson(dto.payload),
            statusEvents: {
              create: { status: MessageStatus.QUEUED },
            },
          },
        });

        await transaction.outboxEvent.create({
          data: {
            aggregateType: "Message",
            aggregateId: message.id,
            eventType: OUTBOUND_REQUESTED_EVENT,
            payload: { messageId: message.id },
          },
        });

        return message;
      });
    } catch (error) {
      if (dto.idempotencyKey) {
        const existing = await this.prisma.message.findFirst({
          where: { tenantId, idempotencyKey: dto.idempotencyKey },
        });
        if (existing) {
          return existing;
        }
      }
      throw new ConflictException("Unable to create outbound message", { cause: error });
    }
  }

  async findById(tenantId: string, id: string) {
    return this.prisma.message.findFirst({
      where: { id, tenantId },
      include: {
        sender: {
          select: {
            id: true,
            providerPhoneNumberId: true,
            displayPhoneNumber: true,
            verifiedName: true,
          },
        },
        statusEvents: { orderBy: { createdAt: "asc" } },
      },
    });
  }

  private mapType(type: OutboundMessageType): MessageType {
    switch (type) {
      case OutboundMessageType.TEXT:
        return MessageType.TEXT;
      case OutboundMessageType.TEMPLATE:
        return MessageType.TEMPLATE;
    }
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
