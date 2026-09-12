import { jest } from "@jest/globals";
import { UnprocessableEntityException } from "@nestjs/common";
import { ConversationStatus } from "../src/generated/prisma/client.js";
import { InboxService } from "../src/inbox/inbox.service.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const TEAM_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_A = "55555555-5555-4555-8555-555555555555";
const AGENT_B = "66666666-6666-4666-8666-666666666666";

const principal = {
  tenantId: TENANT_ID,
  apiKeyId: API_KEY_ID,
  scopes: ["inbox:write"],
};

function conversation(assignedAgentId: string | null) {
  return {
    id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    assignedAgentId,
    status: ConversationStatus.OPEN,
    priority: "NORMAL",
    unreadCount: 0,
    teamAssignment: { teamId: TEAM_ID },
  };
}

function setup(options: {
  assignedAgentId?: string | null;
  teamAssigned?: boolean;
  teamActive?: boolean;
  candidates?: string[];
  loads?: Array<{ assignedAgentId: string; count: number }>;
} = {}) {
  const assignedAgentId = options.assignedAgentId ?? null;
  const teamAssigned = options.teamAssigned ?? true;
  const teamActive = options.teamActive ?? true;
  const candidateIds = options.candidates ?? [AGENT_A, AGENT_B];
  const existing = {
    id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    assignedAgentId,
    teamAssignment: teamAssigned ? { teamId: TEAM_ID } : null,
  };

  const queryRaw = jest.fn();
  queryRaw.mockResolvedValueOnce([]);
  if (assignedAgentId === null && teamAssigned) {
    queryRaw.mockResolvedValueOnce(teamActive ? [{ id: TEAM_ID }] : []);
    if (teamActive) {
      queryRaw.mockResolvedValueOnce(candidateIds.map((agentId) => ({ agentId })));
      if (candidateIds.length > 0) queryRaw.mockResolvedValueOnce([]);
    }
  }

  const findFirst = jest.fn().mockResolvedValue(existing);
  const findFirstOrThrow = jest.fn().mockResolvedValue(conversation(assignedAgentId));
  const update = jest.fn().mockImplementation(({ data }: { data: { assignedAgentId: string } }) => ({
    ...conversation(data.assignedAgentId),
  }));
  const groupBy = jest.fn().mockResolvedValue(
    (options.loads ?? []).map((row) => ({
      assignedAgentId: row.assignedAgentId,
      _count: { _all: row.count },
    })),
  );
  const auditLogCreate = jest.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: queryRaw,
    conversation: { findFirst, findFirstOrThrow, update, groupBy },
    auditLog: { create: auditLogCreate },
  };
  const transaction = jest.fn().mockImplementation(async (callback: (client: unknown) => Promise<unknown>) => callback(tx));
  const service = new InboxService({ $transaction: transaction } as never);

  return { service, queryRaw, groupBy, update, auditLogCreate };
}

describe("InboxService least-loaded routing", () => {
  it("selects the active team member with the lowest OPEN/PENDING workload", async () => {
    const { service, groupBy, update, auditLogCreate } = setup({
      loads: [
        { assignedAgentId: AGENT_A, count: 3 },
        { assignedAgentId: AGENT_B, count: 1 },
      ],
    });

    const result = await service.routeConversation(principal, CONVERSATION_ID);

    expect(groupBy).toHaveBeenCalledWith({
      by: ["assignedAgentId"],
      where: {
        tenantId: TENANT_ID,
        assignedAgentId: { in: [AGENT_A, AGENT_B] },
        status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] },
      },
      _count: { _all: true },
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: CONVERSATION_ID },
      data: { assignedAgentId: AGENT_B },
    }));
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "inbox.conversation.routed",
        metadata: expect.objectContaining({
          strategy: "least_open_pending",
          eligibleAgents: 2,
          selectedLoad: 1,
          assigned: true,
        }),
      }),
    });
    expect(result.changed).toBe(true);
  });

  it("breaks equal workloads by ascending agent ID", async () => {
    const { service, update } = setup({
      loads: [
        { assignedAgentId: AGENT_A, count: 2 },
        { assignedAgentId: AGENT_B, count: 2 },
      ],
    });

    await service.routeConversation(principal, CONVERSATION_ID);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: { assignedAgentId: AGENT_A },
    }));
  });

  it("treats missing workload rows as zero", async () => {
    const { service, update } = setup({
      loads: [{ assignedAgentId: AGENT_A, count: 1 }],
    });

    await service.routeConversation(principal, CONVERSATION_ID);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: { assignedAgentId: AGENT_B },
    }));
  });

  it("returns an already assigned conversation as an idempotent no-op", async () => {
    const { service, queryRaw, groupBy, update, auditLogCreate } = setup({ assignedAgentId: AGENT_A });

    const result = await service.routeConversation(principal, CONVERSATION_ID);

    expect(result.changed).toBe(false);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(groupBy).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("rejects automatic routing without an assigned team", async () => {
    const { service, queryRaw, update } = setup({ teamAssigned: false });

    await expect(service.routeConversation(principal, CONVERSATION_ID))
      .rejects.toThrow("Conversation must be assigned to an inbox team before automatic routing");

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects routing through an inactive assigned team", async () => {
    const { service, queryRaw, update } = setup({ teamActive: false });

    await expect(service.routeConversation(principal, CONVERSATION_ID))
      .rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a team with no active routing members", async () => {
    const { service, queryRaw, groupBy, update } = setup({ candidates: [] });

    await expect(service.routeConversation(principal, CONVERSATION_ID))
      .rejects.toThrow("Assigned inbox team has no active routing members");

    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(groupBy).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
