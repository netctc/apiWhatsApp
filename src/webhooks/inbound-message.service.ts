import { Injectable, Optional } from "@nestjs/common";
import { MessageDirection, MessageStatus, MessageType, Prisma } from "../generated/prisma/client.js";
import { ConversationActivityService } from "../inbox/conversation-activity.service.js";
import { PhoneNumbersService } from "../phone-numbers/phone-numbers.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { normalizePhoneNumber } from "../contacts/phone.util.js";

interface MetaInboundMessage {
  id: string;
  from: string;
  timestamp?: string;
  type?: string;
  [key: string]: unknown;
}

@Injectable()
export class InboundMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly phoneNumbers: PhoneNumbersService,
    @Optional() private readonly conversationActivity?: ConversationActivityService,
  ) {}

  async process(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }

    const entries = (payload as { entry?: unknown }).entry;
    if (!Array.isArray(entries)) {
      return;
    }

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const changes = (entry as { changes?: unknown }).changes;
      if (!Array.isArray(changes)) {
        continue;
      }

      for (const change of changes) {
        if (!change || typeof change !== "object") {
          continue;
        }

        const value = (change as { value?: unknown }).value;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          continue;
        }

        const messages = this.extractMessages(value);
        if (messages.length === 0) {
          continue;
        }

        const metadata = (value as { metadata?: unknown }).metadata;
        const providerPhoneNumberId = this.readString(metadata, "phone_number_id");
        if (!providerPhoneNumberId) {
          throw new Error("Inbound WhatsApp webhook is missing metadata.phone_number_id");
        }

        const displayPhoneNumber = this.readString(metadata, "display_phone_number");
        const sender = await this.phoneNumbers.findByProviderPhoneNumberId(providerPhoneNumberId);
        const profileNames = this.extractProfileNames(value);

        for (const message of messages) {
          await this.persistInboundMessage(
            sender.tenantId,
            sender.id,
            displayPhoneNumber,
            profileNames.get(message.from),
            message,
          );
        }
      }
    }
  }

  private async persistInboundMessage(
    tenantId: string,
    senderId: string,
    displayPhoneNumber: string | undefined,
    profileName: string | undefined,
    message: MetaInboundMessage,
  ): Promise<void> {
    const from = normalizePhoneNumber(message.from);
    const inboundAt = this.parseTimestamp(message.timestamp) ?? new Date();
    const serviceWindowExpiresAt = new Date(inboundAt.getTime() + 24 * 60 * 60 * 1000);

    try {
      await this.prisma.$transaction(async (transaction) => {
        const duplicate = await transaction.message.findUnique({
          where: { providerMessageId: message.id },
          select: { id: true },
        });
        if (duplicate) {
          return;
        }

        const contact = await transaction.contact.upsert({
          where: { tenantId_phone: { tenantId, phone: from } },
          create: {
            tenantId,
            phone: from,
            name: profileName,
            lastInboundAt: inboundAt,
            serviceWindowExpiresAt,
          },
          update: profileName ? { name: profileName } : {},
        });

        await transaction.contact.updateMany({
          where: {
            id: contact.id,
            OR: [
              { lastInboundAt: null },
              { lastInboundAt: { lt: inboundAt } },
            ],
          },
          data: {
            lastInboundAt: inboundAt,
            serviceWindowExpiresAt,
          },
        });

        const conversationId = await this.conversationActivity?.recordInbound(transaction, {
          tenantId,
          senderId,
          contactId: contact.id,
          occurredAt: inboundAt,
        });

        await transaction.message.create({
          data: {
            tenantId,
            senderId,
            ...(conversationId ? { conversationId } : {}),
            direction: MessageDirection.INBOUND,
            type: this.mapMessageType(message.type),
            status: MessageStatus.RECEIVED,
            from,
            to: displayPhoneNumber,
            providerMessageId: message.id,
            providerTimestamp: inboundAt,
            payload: this.toJson(message),
            statusEvents: {
              create: {
                status: MessageStatus.RECEIVED,
                createdAt: inboundAt,
                payload: this.toJson({ providerMessageId: message.id }),
              },
            },
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const duplicate = await this.prisma.message.findUnique({
          where: { providerMessageId: message.id },
          select: { id: true },
        });
        if (duplicate) {
          return;
        }
      }
      throw error;
    }
  }

  private extractMessages(value: object): MetaInboundMessage[] {
    const candidates = (value as { messages?: unknown }).messages;
    if (!Array.isArray(candidates)) {
      return [];
    }

    return candidates.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") {
        return [];
      }
      const id = this.readString(candidate, "id");
      const from = this.readString(candidate, "from");
      if (!id || !from) {
        return [];
      }
      return [{
        ...(candidate as Record<string, unknown>),
        id,
        from,
        timestamp: this.readString(candidate, "timestamp"),
        type: this.readString(candidate, "type"),
      }];
    });
  }

  private extractProfileNames(value: object): Map<string, string> {
    const result = new Map<string, string>();
    const contacts = (value as { contacts?: unknown }).contacts;
    if (!Array.isArray(contacts)) {
      return result;
    }

    for (const contact of contacts) {
      if (!contact || typeof contact !== "object") {
        continue;
      }
      const waId = this.readString(contact, "wa_id");
      const profile = (contact as { profile?: unknown }).profile;
      const name = this.readString(profile, "name");
      if (waId && name) {
        result.set(waId, name);
      }
    }
    return result;
  }

  private mapMessageType(type?: string): MessageType {
    switch (type?.toLowerCase()) {
      case "text":
        return MessageType.TEXT;
      case "image":
        return MessageType.IMAGE;
      case "video":
        return MessageType.VIDEO;
      case "audio":
        return MessageType.AUDIO;
      case "document":
        return MessageType.DOCUMENT;
      case "interactive":
      case "button":
        return MessageType.INTERACTIVE;
      case "location":
        return MessageType.LOCATION;
      case "contacts":
      case "contact":
        return MessageType.CONTACT;
      default:
        return MessageType.UNKNOWN;
    }
  }

  private parseTimestamp(timestamp?: string): Date | undefined {
    if (!timestamp) {
      return undefined;
    }
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return undefined;
    }
    return new Date(seconds * 1000);
  }

  private readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
