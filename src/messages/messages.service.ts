import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { normalizePhoneNumber } from "../contacts/phone.util.js";
import { MessageDirection, MessageStatus, MessageType, Prisma } from "../generated/prisma/client.js";
import { PhoneNumbersService } from "../phone-numbers/phone-numbers.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CreateMessageDto, OutboundMessageType } from "./dto/create-message.dto.js";
import { ListMessagesQueryDto } from "./dto/list-messages-query.dto.js";
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

  async list(tenantId: string, query: ListMessagesQueryDto) {
    if (query.cursor) {
      const cursorMessage = await this.prisma.message.findFirst({
        where: { id: query.cursor, tenantId },
        select: { id: true },
      });
      if (!cursorMessage) {
        throw new BadRequestException("Message cursor is invalid for this tenant");
      }
    }

    const phone = query.phone ? normalizePhoneNumber(query.phone) : undefined;
    const where: Prisma.MessageWhereInput = {
      tenantId,
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.senderId ? { senderId: query.senderId } : {}),
      ...(phone ? { OR: [{ to: phone }, { from: phone }] } : {}),
    };

    const rows = await this.prisma.message.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        sender: {
          select: {
            id: true,
            providerPhoneNumberId: true,
            displayPhoneNumber: true,
            verifiedName: true,
          },
        },
      },
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    };
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
