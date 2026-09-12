import { jest } from "@jest/globals";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import {
  ConversationPriority,
  ConversationStatus,
  InboxAgentPresenceStatus,
} from "../src/generated/prisma/client.js";
import { InboxService } from "../src/inbox/inbox.service.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "33333333-3333-4333-8333-333333333333";
const AGENT_B = "44444444-4444-4444-8444-444444444444";
const CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";

const principal = {
  tenantId: TENANT_ID,
  apiKeyId: API_KEY_ID,
  scopes: ["inbox:write"],
};

const baseConversation = {
  id: CONVERSATION_ID,
  tenantId: TENANT_ID,
  assignedAgentId: null as string | null,
  status: ConversationStatus.OPEN,
  priority: ConversationPriority.NORMAL,
  unreadCount: 2,
};

function setup(
  assignedAgentId: string | null = null,
  presenceStatus = InboxAgentPresenceStatus.AVAILABLE,
) {
  const existing = { ...baseConversation, assignedAgentId };
  const queryRaw = jest.fn().mockResolvedValue([]);
  const conversationFindFirst = jest.fn().mockResolvedValue(existing);
  const conversationFindFirstOrThrow = jest.fn().mockResolvedValue(existing);
  const conversationUpdate = jest.fn().mockResolvedValue({ ...existing, assignedAgentId: AGENT_A });
  const inboxAgentFindFirst = jest.fn().mockResolvedValue({
    id: AGENT_A,
    presenceStatus,
    maxConcurrentConversations: null,
  });
  const auditLogCreate = jest.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: queryRaw,
    conversation: {
      findFirst: conversationFindFirst,
      findFirstOrThrow: conversationFindFirstOrThrow,
      update: conversationUpdate,
    },
    inboxAgent: { findFirst: inboxAgentFindFirst },
    auditLog: { create: auditLogCreate },
  };
  const transaction = jest.fn().mockImplementation(async (callback: (client: unknown) => Promise<unknown>) =>
    callback(tx),
  );
  const service = new InboxService({ $transaction: transaction } as never);
  return {
    service,
    queryRaw,
    conversationFindFirst,
    conversationFindFirstOrThrow,
    conversationUpdate,
    inboxAgentFindFirst,
    auditLogCreate,
  };
}

describe("InboxService conversation claim and release", () => {
  it("claims an unassigned conversation for an available active tenant agent and audits only structural state", async () => {
    const { service, queryRaw, conversationUpdate, inboxAgentFindFirst, auditLogCreate } = setup();

    const result = await service.claimConversation(principal, CONVERSATION_ID, AGENT_A, {
      ipAddress: "203.0.113.10",
      userAgent: "claim-test",
    });

    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(inboxAgentFindFirst).toHaveBeenCalledWith({
      where: { id: AGENT_A, tenantId: TENANT_ID, active: true },
      select: { id: true, presenceStatus: true, maxConcurrentConversations: true },
    });
    expect(conversationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: CONVERSATION_ID },
      data: { assignedAgentId: AGENT_A },
    }));
    expect(result.changed).toBe(true);
    expect(result.conversation.assignedAgentId).toBe(AGENT_A);
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        actorApiKeyId: API_KEY_ID,
        action: "inbox.conversation.claimed",
        entityType: "Conversation",
        entityId: CONVERSATION_ID,
        metadata: { assigned: true },
      }),
    });
    expect(JSON.stringify(auditLogCreate.mock.calls[0]?.[0])).not.toContain(AGENT_A);
  });

  it("treats a repeat claim by the same holder as an idempotent no-op while AWAY", async () => {
    const { service, conversationFindFirstOrThrow, conversationUpdate, auditLogCreate } = setup(
      AGENT_A,
      InboxAgentPresenceStatus.AWAY,
    );

    const result = await service.claimConversation(principal, CONVERSATION_ID, AGENT_A);

    expect(result.changed).toBe(false);
    expect(result.conversation.assignedAgentId).toBe(AGENT_A);
    expect(conversationFindFirstOrThrow).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: CONVERSATION_ID, tenantId: TENANT_ID },
    }));
    expect(conversationUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("rejects a new claim by an AWAY or OFFLINE agent", async () => {
    const away = setup(null, InboxAgentPresenceStatus.AWAY);
    await expect(away.service.claimConversation(principal, CONVERSATION_ID, AGENT_A))
      .rejects.toThrow("Inbox agent is not available for new conversations");
    expect(away.conversationUpdate).not.toHaveBeenCalled();

    const offline = setup(null, InboxAgentPresenceStatus.OFFLINE);
    await expect(offline.service.claimConversation(principal, CONVERSATION_ID, AGENT_A))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(offline.conversationUpdate).not.toHaveBeenCalled();
  });

  it("returns conflict when another agent already holds the conversation", async () => {
    const { service, conversationUpdate, auditLogCreate } = setup(AGENT_B);

    await expect(service.claimConversation(principal, CONVERSATION_ID, AGENT_A))
      .rejects.toBeInstanceOf(ConflictException);

    expect(conversationUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("rejects missing, foreign, or inactive claim agents before assignment", async () => {
    const { service, inboxAgentFindFirst, conversationUpdate, auditLogCreate } = setup();
    inboxAgentFindFirst.mockResolvedValue(null);

    await expect(service.claimConversation(principal, CONVERSATION_ID, AGENT_A))
      .rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(conversationUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("releases a conversation only for its current tenant agent and allows inactive agents to release", async () => {
    const { service, inboxAgentFindFirst, conversationUpdate, auditLogCreate } = setup(AGENT_A);
    conversationUpdate.mockResolvedValue({ ...baseConversation, assignedAgentId: null });

    const result = await service.releaseConversation(principal, CONVERSATION_ID, AGENT_A);

    expect(inboxAgentFindFirst).toHaveBeenCalledWith({
      where: { id: AGENT_A, tenantId: TENANT_ID },
      select: { id: true },
    });
    expect(conversationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: CONVERSATION_ID },
      data: { assignedAgentId: null },
    }));
    expect(result.changed).toBe(true);
    expect(result.conversation.assignedAgentId).toBeNull();
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "inbox.conversation.released",
        metadata: { assigned: false },
      }),
    });
    expect(JSON.stringify(auditLogCreate.mock.calls[0]?.[0])).not.toContain(AGENT_A);
  });

  it("treats release of an already unassigned conversation as a no-op", async () => {
    const { service, conversationUpdate, auditLogCreate } = setup();

    const result = await service.releaseConversation(principal, CONVERSATION_ID, AGENT_A);

    expect(result.changed).toBe(false);
    expect(result.conversation.assignedAgentId).toBeNull();
    expect(conversationUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("returns conflict when another agent tries to release the current holder", async () => {
    const { service, conversationUpdate, auditLogCreate } = setup(AGENT_B);

    await expect(service.releaseConversation(principal, CONVERSATION_ID, AGENT_A))
      .rejects.toBeInstanceOf(ConflictException);

    expect(conversationUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("returns the same not-found result for missing or cross-tenant conversations", async () => {
    const { service, conversationFindFirst, inboxAgentFindFirst } = setup();
    conversationFindFirst.mockResolvedValue(null);

    await expect(service.claimConversation(principal, CONVERSATION_ID, AGENT_A))
      .rejects.toBeInstanceOf(NotFoundException);

    expect(inboxAgentFindFirst).not.toHaveBeenCalled();
  });

  it("propagates audit failure so the surrounding database transaction can roll back", async () => {
    const { service, auditLogCreate } = setup();
    const failure = new Error("audit unavailable");
    auditLogCreate.mockRejectedValue(failure);

    await expect(service.claimConversation(principal, CONVERSATION_ID, AGENT_A)).rejects.toBe(failure);
  });
});
