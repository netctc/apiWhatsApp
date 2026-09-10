import { jest } from "@jest/globals";
import { BadRequestException } from "@nestjs/common";
import { ConversationPriority, ConversationStatus } from "../src/generated/prisma/client.js";
import { InboxService } from "../src/inbox/inbox.service.js";

const principal = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  apiKeyId: "22222222-2222-4222-8222-222222222222",
  scopes: ["inbox:read", "inbox:write"],
};

describe("InboxService", () => {
  it("rejects conflicting assignment filters before querying the database", async () => {
    const service = new InboxService({} as never);

    await expect(
      service.listConversations(principal.tenantId, {
        assignedAgentId: "33333333-3333-4333-8333-333333333333",
        unassigned: true,
        limit: 50,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("audits agent creation without copying identity values into audit metadata", async () => {
    const inboxAgentCreate = jest.fn().mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      tenantId: principal.tenantId,
      name: "Support Agent",
      externalId: "crm-agent-42",
      email: "agent@example.com",
      active: true,
    });
    const auditLogCreate = jest.fn().mockResolvedValue({});
    const transaction = jest.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        inboxAgent: { create: inboxAgentCreate },
        auditLog: { create: auditLogCreate },
      }),
    );
    const service = new InboxService({ $transaction: transaction } as never);

    await service.createAgent(
      principal,
      {
        name: " Support Agent ",
        externalId: " crm-agent-42 ",
        email: "AGENT@example.com",
        metadata: { team: "vip-customers" },
      },
      { ipAddress: "203.0.113.10", userAgent: "integration-test" },
    );

    expect(inboxAgentCreate).toHaveBeenCalledWith({
      data: {
        tenantId: principal.tenantId,
        name: "Support Agent",
        externalId: "crm-agent-42",
        email: "agent@example.com",
        metadata: { team: "vip-customers" },
      },
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: principal.tenantId,
        actorApiKeyId: principal.apiKeyId,
        action: "inbox.agent.created",
        entityType: "InboxAgent",
        entityId: "33333333-3333-4333-8333-333333333333",
        metadata: {
          hasExternalId: true,
          hasEmail: true,
          hasMetadata: true,
        },
      }),
    });
    const auditData = auditLogCreate.mock.calls[0]?.[0] as { data?: { metadata?: unknown } } | undefined;
    expect(JSON.stringify(auditData?.data?.metadata)).not.toContain("agent@example.com");
    expect(JSON.stringify(auditData?.data?.metadata)).not.toContain("crm-agent-42");
    expect(JSON.stringify(auditData?.data?.metadata)).not.toContain("vip-customers");
  });

  it("validates an assigned agent inside the authenticated tenant and writes safe conversation audit metadata", async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const conversationFindFirst = jest.fn().mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      tenantId: principal.tenantId,
    });
    const inboxAgentFindFirst = jest.fn().mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
    });
    const conversationUpdate = jest.fn().mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      status: ConversationStatus.PENDING,
      priority: ConversationPriority.HIGH,
      assignedAgentId: "33333333-3333-4333-8333-333333333333",
    });
    const auditLogCreate = jest.fn().mockResolvedValue({});
    const transaction = jest.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: queryRaw,
        conversation: { findFirst: conversationFindFirst, update: conversationUpdate },
        inboxAgent: { findFirst: inboxAgentFindFirst },
        auditLog: { create: auditLogCreate },
      }),
    );
    const service = new InboxService({ $transaction: transaction } as never);

    await service.updateConversation(
      principal,
      "44444444-4444-4444-8444-444444444444",
      {
        status: ConversationStatus.PENDING,
        priority: ConversationPriority.HIGH,
        assignedAgentId: "33333333-3333-4333-8333-333333333333",
      },
      { ipAddress: "203.0.113.10", userAgent: "integration-test" },
    );

    expect(inboxAgentFindFirst).toHaveBeenCalledWith({
      where: {
        id: "33333333-3333-4333-8333-333333333333",
        tenantId: principal.tenantId,
        active: true,
      },
      select: { id: true },
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "inbox.conversation.updated",
        entityType: "Conversation",
        metadata: {
          changedFields: ["assignedAgentId", "priority", "status"],
          status: ConversationStatus.PENDING,
          priority: ConversationPriority.HIGH,
          assigned: true,
        },
      }),
    });
    expect(JSON.stringify(auditLogCreate.mock.calls[0]?.[0])).not.toContain(
      "33333333-3333-4333-8333-333333333333",
    );
  });
});
