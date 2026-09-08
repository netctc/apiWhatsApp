import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { formatE164PhoneNumber } from "../common/phone-number.util.js";
import {
  ConsentStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
  Prisma,
  WhatsAppChannelStatus,
} from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CreateMessageDto, OutboundMessageType } from "./dto/create-message.dto.js";

const OUTBOUND_REQUESTED_EVENT = "message.outbound.requested";

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateMessageDto) {
    if (dto.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(tenantId, dto.idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    const phoneNumber = this.normalizeRecipient(dto.to);
    const [channel, contact] = await Promise.all([
      this.resolveChannel(tenantId, dto.channelId),
      this.prisma.contact.findUnique({
        where: {
          tenantId_phoneNumber: {
            tenantId,
            phoneNumber,
          },
        },
      }),
    ]);

    this.enforceMessagingWindow(dto.type, contact);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const message = await transaction.message.create({
          data: {
            tenantId,
            channelId: channel.id,
            contactId: contact?.id,
            direction: MessageDirection.OUTBOUND,
            type: this.mapType(dto.type),
            status: MessageStatus.QUEUED,
            to: phoneNumber,
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
      if (dto.idempotencyKey && this.isUniqueConstraintViolation(error)) {
        const existing = await this.findByIdempotencyKey(tenantId, dto.idempotencyKey);
        if (existing) {
          return existing;
        }
      }

      throw error;
    }
  }

  async findById(tenantId: string, id: string) {
    return this.prisma.message.findFirst({
      where: { id, tenantId },
      include: {
        channel: true,
        contact: true,
        statusEvents: { orderBy: { createdAt: "asc" } },
      },
    });
  }

  private async resolveChannel(tenantId: string, requestedChannelId?: string) {
    const channel = await this.prisma.whatsAppChannel.findFirst({
      where: requestedChannelId
        ? {
            id: requestedChannelId,
            tenantId,
            status: WhatsAppChannelStatus.ACTIVE,
          }
        : {
            tenantId,
            status: WhatsAppChannelStatus.ACTIVE,
            isDefault: true,
          },
    });

    if (!channel) {
      throw new UnprocessableEntityException(
        requestedChannelId
          ? "The requested WhatsApp channel is not active for this tenant"
          : "The tenant does not have an active default WhatsApp channel",
      );
    }

    return channel;
  }

  private enforceMessagingWindow(
    type: OutboundMessageType,
    contact: {
      optInStatus: ConsentStatus;
      customerServiceWindowExpiresAt: Date | null;
    } | null,
  ): void {
    const serviceWindowOpen =
      contact?.customerServiceWindowExpiresAt !== null &&
      contact?.customerServiceWindowExpiresAt !== undefined &&
      contact.customerServiceWindowExpiresAt.getTime() > Date.now();

    if (type === OutboundMessageType.TEXT && !serviceWindowOpen) {
      throw new UnprocessableEntityException(
        "Free-form text messages require an open 24-hour customer service window",
      );
    }

    if (
      type === OutboundMessageType.TEMPLATE &&
      !serviceWindowOpen &&
      contact?.optInStatus !== ConsentStatus.OPTED_IN
    ) {
      throw new UnprocessableEntityException(
        "Business-initiated template messages require an opted-in contact outside the customer service window",
      );
    }
  }

  private findByIdempotencyKey(tenantId: string, idempotencyKey: string) {
    return this.prisma.message.findFirst({
      where: { tenantId, idempotencyKey },
    });
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }

  private mapType(type: OutboundMessageType): MessageType {
    switch (type) {
      case OutboundMessageType.TEXT:
        return MessageType.TEXT;
      case OutboundMessageType.TEMPLATE:
        return MessageType.TEMPLATE;
    }
  }

  private normalizeRecipient(value: string): string {
    try {
      return formatE164PhoneNumber(value);
    } catch {
      throw new UnprocessableEntityException("Recipient must be a valid international phone number");
    }
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
