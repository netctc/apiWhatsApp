import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { MessageType, Prisma } from "../generated/prisma/client.js";

interface InboundActivity {
  tenantId: string;
  senderId: string;
  contactId: string;
  occurredAt: Date;
}

interface OutboundActivity {
  tenantId: string;
  senderId: string;
  phone: string;
  messageType: MessageType;
  occurredAt: Date;
}

@Injectable()
export class ConversationActivityService {
  async recordInbound(transaction: Prisma.TransactionClient, activity: InboundActivity): Promise<string> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "Conversation" (
        "id",
        "tenantId",
        "contactId",
        "senderId",
        "status",
        "priority",
        "unreadCount",
        "lastMessageAt",
        "lastInboundAt",
        "createdAt",
        "updatedAt"
      ) VALUES (
        ${randomUUID()}::uuid,
        ${activity.tenantId}::uuid,
        ${activity.contactId}::uuid,
        ${activity.senderId}::uuid,
        'OPEN'::"ConversationStatus",
        'NORMAL'::"ConversationPriority",
        1,
        ${activity.occurredAt},
        ${activity.occurredAt},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("tenantId", "senderId", "contactId") DO UPDATE SET
        "status" = 'OPEN'::"ConversationStatus",
        "resolvedAt" = NULL,
        "unreadCount" = "Conversation"."unreadCount" + 1,
        "lastMessageAt" = GREATEST("Conversation"."lastMessageAt", EXCLUDED."lastMessageAt"),
        "lastInboundAt" = GREATEST(
          COALESCE("Conversation"."lastInboundAt", EXCLUDED."lastInboundAt"),
          EXCLUDED."lastInboundAt"
        ),
        "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "id"
    `);

    const conversationId = rows[0]?.id;
    if (!conversationId) {
      throw new Error("Unable to create or update inbound conversation");
    }
    return conversationId;
  }

  async recordOutbound(
    transaction: Prisma.TransactionClient,
    activity: OutboundActivity,
  ): Promise<string | undefined> {
    // Templates, including marketing campaigns, must not create or reopen inbox conversations.
    if (activity.messageType === MessageType.TEMPLATE) {
      return undefined;
    }

    const contact = await transaction.contact.findUnique({
      where: {
        tenantId_phone: {
          tenantId: activity.tenantId,
          phone: activity.phone,
        },
      },
      select: { id: true },
    });
    if (!contact) {
      return undefined;
    }

    const conversation = await transaction.conversation.upsert({
      where: {
        tenantId_senderId_contactId: {
          tenantId: activity.tenantId,
          senderId: activity.senderId,
          contactId: contact.id,
        },
      },
      create: {
        tenantId: activity.tenantId,
        senderId: activity.senderId,
        contactId: contact.id,
        status: "OPEN",
        lastMessageAt: activity.occurredAt,
        lastOutboundAt: activity.occurredAt,
      },
      update: {
        status: "OPEN",
        resolvedAt: null,
        lastMessageAt: activity.occurredAt,
        lastOutboundAt: activity.occurredAt,
      },
      select: { id: true },
    });

    return conversation.id;
  }
}
