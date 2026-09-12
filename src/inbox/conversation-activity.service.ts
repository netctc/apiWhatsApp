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
    const startsResponseSlaCycle = Prisma.sql`
      EXCLUDED."lastInboundAt" > COALESCE("Conversation"."lastInboundAt", '-infinity'::timestamp)
      AND EXCLUDED."lastInboundAt" > COALESCE("Conversation"."lastOutboundAt", '-infinity'::timestamp)
      AND (
        "Conversation"."status" = 'RESOLVED'::"ConversationStatus"
        OR "Conversation"."responseSlaDueAt" IS NULL
        OR "Conversation"."responseSlaRespondedAt" IS NOT NULL
      )
    `;
    const responseSlaMinutes = Prisma.sql`
      (
        SELECT team."responseSlaMinutes"
        FROM "ConversationTeamAssignment" assignment
        JOIN "InboxTeam" team
          ON team."tenantId" = assignment."tenantId"
          AND team."id" = assignment."teamId"
        WHERE assignment."tenantId" = "Conversation"."tenantId"
          AND assignment."conversationId" = "Conversation"."id"
        LIMIT 1
      )
    `;

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
        "responseSlaStartedAt" = CASE
          WHEN ${startsResponseSlaCycle} THEN
            CASE WHEN ${responseSlaMinutes} IS NULL THEN NULL ELSE EXCLUDED."lastInboundAt" END
          ELSE "Conversation"."responseSlaStartedAt"
        END,
        "responseSlaDueAt" = CASE
          WHEN ${startsResponseSlaCycle} THEN
            CASE
              WHEN ${responseSlaMinutes} IS NULL THEN NULL
              ELSE EXCLUDED."lastInboundAt" + (${responseSlaMinutes} * INTERVAL '1 minute')
            END
          ELSE "Conversation"."responseSlaDueAt"
        END,
        "responseSlaRespondedAt" = CASE
          WHEN ${startsResponseSlaCycle} THEN NULL
          ELSE "Conversation"."responseSlaRespondedAt"
        END,
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

    const closesResponseSlaCycle = Prisma.sql`
      "Conversation"."status" <> 'RESOLVED'::"ConversationStatus"
      AND "Conversation"."responseSlaStartedAt" IS NOT NULL
      AND "Conversation"."responseSlaDueAt" IS NOT NULL
      AND "Conversation"."responseSlaRespondedAt" IS NULL
      AND EXCLUDED."lastOutboundAt" >= "Conversation"."responseSlaStartedAt"
      AND EXCLUDED."lastOutboundAt" > COALESCE("Conversation"."lastOutboundAt", '-infinity'::timestamp)
    `;

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
        "lastOutboundAt",
        "createdAt",
        "updatedAt"
      ) VALUES (
        ${randomUUID()}::uuid,
        ${activity.tenantId}::uuid,
        ${contact.id}::uuid,
        ${activity.senderId}::uuid,
        'OPEN'::"ConversationStatus",
        'NORMAL'::"ConversationPriority",
        0,
        ${activity.occurredAt},
        ${activity.occurredAt},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("tenantId", "senderId", "contactId") DO UPDATE SET
        "status" = 'OPEN'::"ConversationStatus",
        "resolvedAt" = NULL,
        "lastMessageAt" = GREATEST("Conversation"."lastMessageAt", EXCLUDED."lastMessageAt"),
        "lastOutboundAt" = GREATEST(
          COALESCE("Conversation"."lastOutboundAt", EXCLUDED."lastOutboundAt"),
          EXCLUDED."lastOutboundAt"
        ),
        "responseSlaStartedAt" = CASE
          WHEN "Conversation"."status" = 'RESOLVED'::"ConversationStatus" THEN NULL
          ELSE "Conversation"."responseSlaStartedAt"
        END,
        "responseSlaDueAt" = CASE
          WHEN "Conversation"."status" = 'RESOLVED'::"ConversationStatus" THEN NULL
          ELSE "Conversation"."responseSlaDueAt"
        END,
        "responseSlaRespondedAt" = CASE
          WHEN "Conversation"."status" = 'RESOLVED'::"ConversationStatus" THEN NULL
          WHEN ${closesResponseSlaCycle} THEN EXCLUDED."lastOutboundAt"
          ELSE "Conversation"."responseSlaRespondedAt"
        END,
        "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "id"
    `);

    const conversationId = rows[0]?.id;
    if (!conversationId) {
      throw new Error("Unable to create or update outbound conversation");
    }
    return conversationId;
  }
}
