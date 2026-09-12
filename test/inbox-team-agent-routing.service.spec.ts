import { jest } from "@jest/globals";
import { UnprocessableEntityException } from "@nestjs/common";
import {
  ConversationStatus,
  InboxAgentPresenceStatus,
} from "../src/generated/prisma/client.js";
import { InboxService } from "../src/inbox/inbox.service.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_A = "44444444-4444-4444-8444-444444444444";
const AGENT_B = "55555555-5555-4555-8555-555555555555";
const TEAM_A = "66666666-6666-4666-8666-666666666666";
const TEAM_B = "77777777-7777-4777-8777-777777777777";

const principal = {
  tenantId: TENANT_ID,
  apiKeyId: API_KEY_ID,
  scopes: ["inbox:write"],
};

function setup(options: {
  assignedAgentId?: string | null;
  assignedTeamId?: string | null;
  member?: boolean;
} = {}) {
  const assignedAgentId = options.assignedAgentId ?? null;
  const assignedTeamId = options.assignedTeamId ?? null;
  const queryRaw = jest.fn().mockResolvedValue([]);
  const conversationFindFirst = jest.fn().mockResolvedValue({
    id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    assignedAgentId,
    teamAssignment: assignedTeamId ? { teamId: assignedTeamId } : null,
  });
  const conversationFindFirstOrThrow = jest.fn().mockResolvedValue({
    id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    assignedAgentId,
    teamAssignment: assignedTeamId ? { teamId: assignedTeamId } : null,
  });
  const conversationUpdate = jest.fn().mockImplementation(({ data }: { data: { assignedAgentId?: string | null } }) => ({
    id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    assignedAgentId: data.assignedAgentId === undefined ? assignedAgentId : data.assignedAgentId,
    status: ConversationStatus.OPEN,
    priority: "NORMAL",
    teamAssignment: assignedTeamId ? { teamId: assignedTeamId } : null,
  }));
  const agentFindFirst = jest.fn().mockImplementation(({ where }: { where: { id: string } }) => ({
    id: where.id,
    presenceStatus: InboxAgentPresenceStatus.AVAILABLE,
    maxConcurrentConversations: null,
  }));
  const teamFindFirst = jest.fn().mockResolvedValue({ id: TEAM_A });
  const membershipFindFirst = jest.fn().mockResolvedValue(options.member === false ? null : { teamId: TEAM_A });
  const assignmentUpsert = jest.fn().mockResolvedValue({});
  const assignmentDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const auditLogCreate = jest.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: queryRaw,
    conversation: {
      findFirst: conversationFindFirst,
      findFirstOrThrow: conversationFindFirstOrThrow,
      update: conversationUpdate,
    },
    inboxAgent: { findFirst: agentFindFirst },
    inboxTeam: { findFirst: teamFindFirst },
    inboxTeamMember: { findFirst: membershipFindFirst },
    conversationTeamAssignment: {
      upsert: assignmentUpsert,
      deleteMany: assignmentDeleteMany,
    },
    auditLog: { create: auditLogCreate },
  };
  const transaction = jest.fn().mockImplementation(async (callback: (client: unknown) => Promise<unknown>) => callback(tx));
  const service = new InboxService({ $transaction: transaction } as never);

  return {
    service,
    membershipFindFirst,
    conversationUpdate,
    assignmentUpsert,
    assignmentDeleteMany,
    auditLogCreate,
  };
}

describe("InboxService team-agent routing invariant", () => {
  it("rejects assigning an agent that is not a member of the existing team", async () => {
    const { service, membershipFindFirst, conversationUpdate, auditLogCreate } = setup({
      assignedTeamId: TEAM_A,
      member: false,
    });

    await expect(service.updateConversation(principal, CONVERSATION_ID, { assignedAgentId: AGENT_A }))
      .rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(membershipFindFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, teamId: TEAM_A, agentId: AGENT_A },
      select: { teamId: true },
    });
    expect(conversationUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("rejects assigning a team whose existing agent is not a member", async () => {
    const { service, membershipFindFirst, assignmentUpsert } = setup({
      assignedAgentId: AGENT_A,
      member: false,
    });

    await expect(service.updateConversation(principal, CONVERSATION_ID, { assignedTeamId: TEAM_A }))
      .rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(membershipFindFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, teamId: TEAM_A, agentId: AGENT_A },
      select: { teamId: true },
    });
    expect(assignmentUpsert).not.toHaveBeenCalled();
  });

  it("validates the final pair when team and agent move together in one patch", async () => {
    const { service, membershipFindFirst, assignmentUpsert, conversationUpdate } = setup({ member: true });

    await service.updateConversation(principal, CONVERSATION_ID, {
      assignedTeamId: TEAM_B,
      assignedAgentId: AGENT_B,
    });

    expect(membershipFindFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, teamId: TEAM_B, agentId: AGENT_B },
      select: { teamId: true },
    });
    expect(assignmentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ teamId: TEAM_B }),
      update: { teamId: TEAM_B },
    }));
    expect(conversationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ assignedAgentId: AGENT_B }),
    }));
  });

  it("allows removing the team while retaining a historically assigned agent", async () => {
    const { service, membershipFindFirst, assignmentDeleteMany, conversationUpdate } = setup({
      assignedAgentId: AGENT_A,
      assignedTeamId: TEAM_A,
      member: false,
    });

    await service.updateConversation(principal, CONVERSATION_ID, { assignedTeamId: null });

    expect(membershipFindFirst).not.toHaveBeenCalled();
    expect(assignmentDeleteMany).toHaveBeenCalled();
    expect(conversationUpdate).toHaveBeenCalled();
  });

  it("does not retroactively block status-only mutations after membership removal", async () => {
    const { service, membershipFindFirst, conversationUpdate } = setup({
      assignedAgentId: AGENT_A,
      assignedTeamId: TEAM_A,
      member: false,
    });

    await service.updateConversation(principal, CONVERSATION_ID, { status: ConversationStatus.PENDING });

    expect(membershipFindFirst).not.toHaveBeenCalled();
    expect(conversationUpdate).toHaveBeenCalled();
  });

  it("rejects a new claim by an agent outside the assigned team", async () => {
    const { service, membershipFindFirst, conversationUpdate, auditLogCreate } = setup({
      assignedTeamId: TEAM_A,
      member: false,
    });

    await expect(service.claimConversation(principal, CONVERSATION_ID, AGENT_A))
      .rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(membershipFindFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, teamId: TEAM_A, agentId: AGENT_A },
      select: { teamId: true },
    });
    expect(conversationUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("allows a team member to claim the team conversation", async () => {
    const { service, membershipFindFirst, conversationUpdate } = setup({
      assignedTeamId: TEAM_A,
      member: true,
    });

    const result = await service.claimConversation(principal, CONVERSATION_ID, AGENT_A);

    expect(membershipFindFirst).toHaveBeenCalledTimes(1);
    expect(conversationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { assignedAgentId: AGENT_A },
    }));
    expect(result.changed).toBe(true);
  });

  it("keeps a repeat claim idempotent after the holder membership is removed", async () => {
    const { service, membershipFindFirst, conversationUpdate, auditLogCreate } = setup({
      assignedAgentId: AGENT_A,
      assignedTeamId: TEAM_A,
      member: false,
    });

    const result = await service.claimConversation(principal, CONVERSATION_ID, AGENT_A);

    expect(result.changed).toBe(false);
    expect(membershipFindFirst).not.toHaveBeenCalled();
    expect(conversationUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });
});
