import { ConflictException, Injectable } from "@nestjs/common";
import { MessageDirection, MessageStatus, MessageType, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CreateMessageDto, OutboundMessageType } from "./dto/create-message.dto.js";

const OUTBOUND_REQUESTED_EVENT = "message.outbound.requested";

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateMessageDto) {
    if (dto.idempotencyKey) {
      const existing = await this.prisma.message.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
      });

      if (existing) {
        return existing;
      }
    }

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const message = await transaction.message.create({
          data: {
            direction: MessageDirection.OUTBOUND,
            type: this.mapType(dto.type),
            status: MessageStatus.QUEUED,
            to: dto.to,
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
        const existing = await this.prisma.message.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
        });
        if (existing) {
          return existing;
        }
      }
      throw new ConflictException("Unable to create outbound message", { cause: error });
    }
  }

  async findById(id: string) {
    return this.prisma.message.findUnique({
      where: { id },
      include: { statusEvents: { orderBy: { createdAt: "asc" } } },
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
