import { ConflictException, Injectable } from "@nestjs/common";
import { MessageDirection, MessageStatus, MessageType } from "../../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { MessagingQueueService } from "../queue/messaging-queue.service.js";
import { CreateMessageDto, OutboundMessageType } from "./dto/create-message.dto.js";

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: MessagingQueueService,
  ) {}

  async create(dto: CreateMessageDto) {
    if (dto.idempotencyKey) {
      const existing = await this.prisma.message.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
      });

      if (existing) {
        return existing;
      }
    }

    let message;
    try {
      message = await this.prisma.message.create({
        data: {
          direction: MessageDirection.OUTBOUND,
          type: this.mapType(dto.type),
          status: MessageStatus.QUEUED,
          to: dto.to,
          idempotencyKey: dto.idempotencyKey,
          payload: dto.payload,
          statusEvents: {
            create: { status: MessageStatus.QUEUED },
          },
        },
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

    await this.queue.publishOutboundMessage(message.id);
    return message;
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
}
