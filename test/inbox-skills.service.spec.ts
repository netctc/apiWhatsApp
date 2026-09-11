import { jest } from "@jest/globals";
import { BadRequestException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { InboxSkillsService } from "../src/inbox/inbox-skills.service.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY_ID = "22222222-2222-4222-8222-222222222222";
const SKILL_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";

const principal = {
  tenantId: TENANT_ID,
  apiKeyId: API_KEY_ID,
  scopes: ["inbox:write"],
};

const skill = {
  id: SKILL_ID,
  tenantId: TENANT_ID,
  name: "Billing",
  description: null,
  active: true,
  createdAt: new Date("2026-09-11T00:00:00.000Z"),
  updatedAt: new Date("2026-09-11T00:00:00.000Z"),
  assignments: [],
};

function setup() {
  const skillCreate = jest.fn().mockResolvedValue(skill);
  const txSkillFindFirst = jest.fn().mockResolvedValue({ id: SKILL_ID, active: true });
  const skillUpdate = jest.fn().mockResolvedValue(skill);
  const txAgentFindFirst = jest.fn().mockResolvedValue({ id: AGENT_ID, active: true });
  const assignmentFindUnique = jest.fn().mockResolvedValue(null);
  const assignmentUpdate = jest.fn().mockResolvedValue({});
  const assignmentCreateMany = jest.fn().mockResolvedValue({ count: 1 });
  const assignmentUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
  const assignmentDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const auditLogCreate = jest.fn().mockResolvedValue({});
  const tx = {
    inboxSkill: {
      create: skillCreate,
      findFirst: txSkillFindFirst,
      update: skillUpdate,
    },
    inboxAgent: { findFirst: txAgentFindFirst },
    inboxAgentSkill: {
      findUnique: assignmentFindUnique,
      update: assignmentUpdate,
      createMany: assignmentCreateMany,
      updateMany: assignmentUpdateMany,
      deleteMany: assignmentDeleteMany,
    },
    auditLog: { create: auditLogCreate },
  };
  const transaction = jest.fn().mockImplementation(async (callback: (client: unknown) => Promise<unknown>) =>
    callback(tx),
  );
  const topSkillFindFirst = jest.fn().mockResolvedValue(skill);
  const service = new InboxSkillsService({
    $transaction: transaction,
    inboxSkill: {
      findFirst: topSkillFindFirst,
      findMany: jest.fn(),
    },
  } as never);

  return {
    service,
    skillCreate,
    txSkillFindFirst,
    skillUpdate,
    txAgentFindFirst,
    assignmentFindUnique,
    assignmentUpdate,
    assignmentCreateMany,
    assignmentUpdateMany,
    assignmentDeleteMany,
    auditLogCreate,
  };
}

describe("InboxSkillsService", () => {
  it("creates a tenant skill and audits the committed mutation", async () => {
    const { service, skillCreate, auditLogCreate } = setup();

    await service.createSkill(principal, { name: "  Billing  ", description: "  Payment help  " });

    expect(skillCreate).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT_ID,
        name: "Billing",
        description: "Payment help",
      },
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        actorApiKeyId: API_KEY_ID,
        action: "inbox.skill.created",
        entityType: "InboxSkill",
        entityId: SKILL_ID,
      }),
    });
  });

  it("assigns an active tenant agent with a proficiency level", async () => {
    const { service, assignmentCreateMany, auditLogCreate } = setup();

    await service.setAgentSkill(principal, SKILL_ID, AGENT_ID, { level: 3 });

    expect(assignmentCreateMany).toHaveBeenCalledWith({
      data: [{ tenantId: TENANT_ID, skillId: SKILL_ID, agentId: AGENT_ID, level: 3 }],
      skipDuplicates: true,
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "inbox.skill.agent.assigned",
        entityType: "InboxAgentSkill",
        entityId: `${SKILL_ID}:${AGENT_ID}`,
      }),
    });
  });

  it("treats the same existing proficiency as an idempotent no-op", async () => {
    const { service, assignmentFindUnique, assignmentUpdate, assignmentCreateMany, auditLogCreate } = setup();
    assignmentFindUnique.mockResolvedValue({
      tenantId: TENANT_ID,
      skillId: SKILL_ID,
      agentId: AGENT_ID,
      level: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.setAgentSkill(principal, SKILL_ID, AGENT_ID, { level: 3 });

    expect(assignmentUpdate).not.toHaveBeenCalled();
    expect(assignmentCreateMany).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("updates and audits a changed proficiency level", async () => {
    const { service, assignmentFindUnique, assignmentUpdate, auditLogCreate } = setup();
    assignmentFindUnique.mockResolvedValue({
      tenantId: TENANT_ID,
      skillId: SKILL_ID,
      agentId: AGENT_ID,
      level: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.setAgentSkill(principal, SKILL_ID, AGENT_ID, { level: 5 });

    expect(assignmentUpdate).toHaveBeenCalledWith({
      where: { skillId_agentId: { skillId: SKILL_ID, agentId: AGENT_ID } },
      data: { level: 5 },
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "inbox.skill.agent.level.updated",
        metadata: { fromLevel: 2, toLevel: 5 },
      }),
    });
  });

  it("rejects new assignments to inactive skills or agents", async () => {
    const { service, txSkillFindFirst, txAgentFindFirst, assignmentCreateMany } = setup();
    txSkillFindFirst.mockResolvedValue({ id: SKILL_ID, active: false });

    await expect(service.setAgentSkill(principal, SKILL_ID, AGENT_ID, { level: 2 }))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(assignmentCreateMany).not.toHaveBeenCalled();

    txSkillFindFirst.mockResolvedValue({ id: SKILL_ID, active: true });
    txAgentFindFirst.mockResolvedValue({ id: AGENT_ID, active: false });
    await expect(service.setAgentSkill(principal, SKILL_ID, AGENT_ID, { level: 2 }))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("permits updating an existing proficiency after later deactivation", async () => {
    const { service, txSkillFindFirst, txAgentFindFirst, assignmentFindUnique, assignmentUpdate } = setup();
    txSkillFindFirst.mockResolvedValue({ id: SKILL_ID, active: false });
    txAgentFindFirst.mockResolvedValue({ id: AGENT_ID, active: false });
    assignmentFindUnique.mockResolvedValue({
      tenantId: TENANT_ID,
      skillId: SKILL_ID,
      agentId: AGENT_ID,
      level: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.setAgentSkill(principal, SKILL_ID, AGENT_ID, { level: 4 });

    expect(assignmentUpdate).toHaveBeenCalledWith({
      where: { skillId_agentId: { skillId: SKILL_ID, agentId: AGENT_ID } },
      data: { level: 4 },
    });
  });

  it("keeps cross-tenant skills indistinguishable from missing skills", async () => {
    const { service, txSkillFindFirst, txAgentFindFirst } = setup();
    txSkillFindFirst.mockResolvedValue(null);

    await expect(service.setAgentSkill(principal, SKILL_ID, AGENT_ID, { level: 2 }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(txAgentFindFirst).not.toHaveBeenCalled();
  });

  it("treats removing a missing proficiency as an idempotent no-op", async () => {
    const { service, assignmentDeleteMany, auditLogCreate } = setup();
    assignmentDeleteMany.mockResolvedValue({ count: 0 });

    await service.removeAgentSkill(principal, SKILL_ID, AGENT_ID);

    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("rejects empty skill updates before opening a mutation transaction", async () => {
    const { service } = setup();

    await expect(service.updateSkill(principal, SKILL_ID, {}))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it("propagates audit failure so the surrounding assignment transaction can roll back", async () => {
    const { service, auditLogCreate } = setup();
    const failure = new Error("audit unavailable");
    auditLogCreate.mockRejectedValue(failure);

    await expect(service.setAgentSkill(principal, SKILL_ID, AGENT_ID, { level: 2 })).rejects.toBe(failure);
  });
});
