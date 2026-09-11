import { jest } from "@jest/globals";
import { BadRequestException, UnprocessableEntityException } from "@nestjs/common";
import { InboxService } from "../src/inbox/inbox.service.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const TEAM_ID = "44444444-4444-4444-8444-444444444444";

const principal = {
  tenantId: TENANT_ID,
  apiKeyId: API_KEY_ID,
  scopes: ["inbox:write"],
};

function conversation(teamId: string | null) {
  return {
    id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    contactId: "55555555-5555-4555-8555-555555555555",
    senderId: "66666666-6666-4666-8666-666666666666",
    assignedAgentId: null,
    status: "OPEN",
    priority: "NORMAL",
    unreadCount: 0,
    lastMessageAt: new Date(),
    lastInboundAt: null,
    lastOutboundAt: null,
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    contact: {},
    sender: {},
    assignedAgent: null,
    teamAssignment: teamId
      ? {
          teamId,
          createdAt: new Date(),
          updatedAt: new Date(),
          team: { id: teamId, name: "Support", description: null, active: true },
        }
      : null,
    messages: [],
  };
}

function setup() {
  const queryRaw = jest.fn().mockResolvedValue([]);
  const conversationFindFirst = jest.fn().mockResolvedValue({
    id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    assignedAgentId: null,
  });
  const conversationUpdate = jest.fn().mockResolvedValue(conversation(TEAM_ID));
  const teamFindFirst = jest.fn().mockResolvedValue({ id: TEAM_ID });
  const assignmentUpsert = jest.fn().mockResolvedValue({});
  const assignmentDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const auditLogCreate = jest.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: queryRaw,
    conversation: {
      findFirst: conversationFindFirst,
      update: conversationUpdate,
    },
    inboxAgent: { findFirst: jest.fn() },
    inboxTeam: { findFirst: teamFindFirst },
    conversationTeamAssignment: {
      upsert: assignmentUpsert,
      deleteMany: assignmentDeleteMany,
    },
    auditLog: { create: auditLogCreate },
  };
  const transaction = jest.fn().mockImplementation(async (callback: (client: unknown) => Promise<unknown>) =>
    callback(tx),
  );
  const findMany = jest.fn().mockResolvedValue([]);
  const service = new InboxService({
    $transaction: transaction,
    conversation: {
      findMany,
      findFirst: jest.fn(),
    },
  } as never);

  return {
    service,
    queryRaw,
    conversationUpdate,
    teamFindFirst,
    assignmentUpsert,
    assignmentDeleteMany,
    auditLogCreate,
    findMany,
  };
}

describe("InboxService conversation team assignment", () => {
  it("assigns one active tenant team under the conversation row lock", async () => {
    const { service, queryRaw, teamFindFirst, assignmentUpsert, auditLogCreate } = setup();

    const result = await service.updateConversation(principal, CONVERSATION_ID, {
      assignedTeamId: TEAM_ID,
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(teamFindFirst).toHaveBeenCalledWith({
      where: { id: TEAM_ID, tenantId: TENANT_ID, active: true },
      select: { id: true },
    });
    expect(assignmentUpsert).toHaveBeenCalledWith({
      where: { conversationId: CONVERSATION_ID },
      create: {
        tenantId: TENANT_ID,
        conversationId: CONVERSATION_ID,
        teamId: TEAM_ID,
      },
      update: { teamId: TEAM_ID },
    });
    expect(result.teamAssignment?.teamId).toBe(TEAM_ID);
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "inbox.conversation.updated",
        entityType: "Conversation",
        entityId: CONVERSATION_ID,
        metadata: expect.objectContaining({
          changedFields: ["assignedTeamId"],
          teamAssigned: true,
        }),
      }),
    });
  });

  it("unassigns a team without requiring the team to remain active", async () => {
    const { service, teamFindFirst, assignmentDeleteMany, conversationUpdate } = setup();
    conversationUpdate.mockResolvedValue(conversation(null));

    const result = await service.updateConversation(principal, CONVERSATION_ID, {
      assignedTeamId: null,
    });

    expect(teamFindFirst).not.toHaveBeenCalled();
    expect(assignmentDeleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, conversationId: CONVERSATION_ID },
    });
    expect(result.teamAssignment).toBeNull();
  });

  it("rejects a missing, inactive, or foreign team before writing assignment", async () => {
    const { service, teamFindFirst, assignmentUpsert, auditLogCreate } = setup();
    teamFindFirst.mockResolvedValue(null);

    await expect(service.updateConversation(principal, CONVERSATION_ID, {
      assignedTeamId: TEAM_ID,
    })).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(assignmentUpsert).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("propagates audit failure so the team assignment transaction can roll back", async () => {
    const { service, auditLogCreate } = setup();
    const failure = new Error("audit unavailable");
    auditLogCreate.mockRejectedValue(failure);

    await expect(service.updateConversation(principal, CONVERSATION_ID, {
      assignedTeamId: TEAM_ID,
    })).rejects.toBe(failure);
  });

  it("rejects contradictory team list filters", async () => {
    const { service, findMany } = setup();

    await expect(service.listConversations(TENANT_ID, {
      assignedTeamId: TEAM_ID,
      unassignedTeam: true,
      limit: 50,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("filters conversations through the tenant-safe team assignment relation", async () => {
    const { service, findMany } = setup();

    await service.listConversations(TENANT_ID, {
      assignedTeamId: TEAM_ID,
      limit: 50,
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: TENANT_ID,
        teamAssignment: { is: { tenantId: TENANT_ID, teamId: TEAM_ID } },
      }),
    }));
  });
});
