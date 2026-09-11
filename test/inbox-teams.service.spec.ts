import { jest } from "@jest/globals";
import { BadRequestException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { InboxTeamsService } from "../src/inbox/inbox-teams.service.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY_ID = "22222222-2222-4222-8222-222222222222";
const TEAM_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";

const principal = {
  tenantId: TENANT_ID,
  apiKeyId: API_KEY_ID,
  scopes: ["inbox:write"],
};

const team = {
  id: TEAM_ID,
  tenantId: TENANT_ID,
  name: "Support",
  description: null,
  active: true,
  createdAt: new Date("2026-09-11T00:00:00.000Z"),
  updatedAt: new Date("2026-09-11T00:00:00.000Z"),
};

function setup() {
  const teamCreate = jest.fn().mockResolvedValue(team);
  const txTeamFindFirst = jest.fn().mockResolvedValue({ id: TEAM_ID });
  const teamUpdate = jest.fn().mockResolvedValue(team);
  const txAgentFindFirst = jest.fn().mockResolvedValue({ id: AGENT_ID, active: true });
  const memberCreateMany = jest.fn().mockResolvedValue({ count: 1 });
  const memberDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const auditLogCreate = jest.fn().mockResolvedValue({});
  const tx = {
    inboxTeam: {
      create: teamCreate,
      findFirst: txTeamFindFirst,
      update: teamUpdate,
    },
    inboxAgent: { findFirst: txAgentFindFirst },
    inboxTeamMember: {
      createMany: memberCreateMany,
      deleteMany: memberDeleteMany,
    },
    auditLog: { create: auditLogCreate },
  };
  const transaction = jest.fn().mockImplementation(async (callback: (client: unknown) => Promise<unknown>) =>
    callback(tx),
  );

  const topTeamFindFirst = jest.fn().mockResolvedValue(team);
  const topMembershipFindMany = jest.fn().mockResolvedValue([
    { tenantId: TENANT_ID, teamId: TEAM_ID, agentId: AGENT_ID, createdAt: team.createdAt },
  ]);
  const topAgentFindMany = jest.fn().mockResolvedValue([
    { id: AGENT_ID, externalId: null, name: "Agent", email: null, active: true },
  ]);
  const service = new InboxTeamsService({
    $transaction: transaction,
    inboxTeam: {
      findFirst: topTeamFindFirst,
      findMany: jest.fn(),
    },
    inboxTeamMember: { findMany: topMembershipFindMany },
    inboxAgent: { findMany: topAgentFindMany },
  } as never);

  return {
    service,
    teamCreate,
    txTeamFindFirst,
    teamUpdate,
    txAgentFindFirst,
    memberCreateMany,
    memberDeleteMany,
    auditLogCreate,
    topMembershipFindMany,
    topAgentFindMany,
  };
}

describe("InboxTeamsService", () => {
  it("creates a tenant team and audits the committed mutation", async () => {
    const { service, teamCreate, auditLogCreate } = setup();

    await service.createTeam(principal, { name: "  Support  ", description: "  Tier one  " }, {
      ipAddress: "203.0.113.10",
      userAgent: "team-test",
    });

    expect(teamCreate).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT_ID,
        name: "Support",
        description: "Tier one",
      },
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        actorApiKeyId: API_KEY_ID,
        action: "inbox.team.created",
        entityType: "InboxTeam",
        entityId: TEAM_ID,
      }),
    });
  });

  it("adds one active tenant agent idempotently and returns hydrated membership", async () => {
    const { service, txAgentFindFirst, memberCreateMany, auditLogCreate } = setup();

    const result = await service.addMember(principal, TEAM_ID, AGENT_ID);

    expect(txAgentFindFirst).toHaveBeenCalledWith({
      where: { id: AGENT_ID, tenantId: TENANT_ID },
      select: { id: true, active: true },
    });
    expect(memberCreateMany).toHaveBeenCalledWith({
      data: [{ tenantId: TENANT_ID, teamId: TEAM_ID, agentId: AGENT_ID }],
      skipDuplicates: true,
    });
    expect(result.members).toHaveLength(1);
    expect(result.members[0]?.agent.id).toBe(AGENT_ID);
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "inbox.team.member.added",
        entityType: "InboxTeamMember",
        entityId: `${TEAM_ID}:${AGENT_ID}`,
      }),
    });
  });

  it("does not duplicate audit when re-adding an existing membership", async () => {
    const { service, memberCreateMany, auditLogCreate } = setup();
    memberCreateMany.mockResolvedValue({ count: 0 });

    await service.addMember(principal, TEAM_ID, AGENT_ID);

    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("rejects inactive or foreign agents before creating membership", async () => {
    const { service, txAgentFindFirst, memberCreateMany, auditLogCreate } = setup();
    txAgentFindFirst.mockResolvedValue({ id: AGENT_ID, active: false });

    await expect(service.addMember(principal, TEAM_ID, AGENT_ID))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(memberCreateMany).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();

    txAgentFindFirst.mockResolvedValue(null);
    await expect(service.addMember(principal, TEAM_ID, AGENT_ID))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("treats removing a missing membership as an idempotent no-op", async () => {
    const { service, memberDeleteMany, auditLogCreate } = setup();
    memberDeleteMany.mockResolvedValue({ count: 0 });

    const result = await service.removeMember(principal, TEAM_ID, AGENT_ID);

    expect(result.id).toBe(TEAM_ID);
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("keeps cross-tenant teams indistinguishable from missing teams", async () => {
    const { service, txTeamFindFirst, txAgentFindFirst } = setup();
    txTeamFindFirst.mockResolvedValue(null);

    await expect(service.addMember(principal, TEAM_ID, AGENT_ID))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(txAgentFindFirst).not.toHaveBeenCalled();
  });

  it("rejects empty updates before opening a mutation transaction", async () => {
    const { service } = setup();

    await expect(service.updateTeam(principal, TEAM_ID, {}))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it("propagates audit failure so the surrounding transaction can roll back", async () => {
    const { service, auditLogCreate } = setup();
    const failure = new Error("audit unavailable");
    auditLogCreate.mockRejectedValue(failure);

    await expect(service.addMember(principal, TEAM_ID, AGENT_ID)).rejects.toBe(failure);
  });
});
