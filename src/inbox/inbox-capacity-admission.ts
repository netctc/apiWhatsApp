import { UnprocessableEntityException } from "@nestjs/common";
import {
  ConversationStatus,
  InboxAgentPresenceStatus,
  Prisma,
} from "../generated/prisma/client.js";

export type LockedAgentCapacity = {
  agentId: string;
  presenceStatus: InboxAgentPresenceStatus;
  maxConcurrentConversations: number | null;
};

export async function lockActiveAgentCapacity(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  agentId: string,
  inactiveMessage: string,
): Promise<LockedAgentCapacity> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "InboxAgent"
    WHERE "id" = ${agentId}::uuid
      AND "tenantId" = ${tenantId}::uuid
    FOR UPDATE
  `);

  const agent = await transaction.inboxAgent.findFirst({
    where: { id: agentId, tenantId, active: true },
    select: { id: true, presenceStatus: true, maxConcurrentConversations: true },
  });
  if (!agent) {
    throw new UnprocessableEntityException(inactiveMessage);
  }

  return {
    agentId: agent.id,
    presenceStatus: agent.presenceStatus,
    maxConcurrentConversations: agent.maxConcurrentConversations ?? null,
  };
}

export function assertAgentAvailableForConversation(
  agent: LockedAgentCapacity,
  presenceMessage: string,
): void {
  if (agent.presenceStatus !== InboxAgentPresenceStatus.AVAILABLE) {
    throw new UnprocessableEntityException(presenceMessage);
  }
}

export async function assertAgentHasConversationCapacity(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  agent: LockedAgentCapacity,
  capacityMessage: string,
): Promise<number | null> {
  if (agent.maxConcurrentConversations === null) {
    return null;
  }

  const load = await transaction.conversation.count({
    where: {
      tenantId,
      assignedAgentId: agent.agentId,
      status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] },
    },
  });
  if (load >= agent.maxConcurrentConversations) {
    throw new UnprocessableEntityException(capacityMessage);
  }
  return load;
}
