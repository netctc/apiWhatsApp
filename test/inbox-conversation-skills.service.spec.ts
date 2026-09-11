import { jest } from "@jest/globals";
import { UnprocessableEntityException } from "@nestjs/common";
import { InboxConversationSkillsService } from "../src/inbox/inbox-conversation-skills.service.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const API_KEY_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const SKILL_ID = "44444444-4444-4444-8444-444444444444";

const principal = {
  tenantId: TENANT_ID,
  apiKeyId: API_KEY_ID,
  scopes: ["inbox:write"],
};

function setup(options: {
  skillActive?: boolean;
  existingLevel?: number | null;
  removedCount?: number;
} = {}) {
  const queryRaw = jest.fn().mockResolvedValue([]);
  const conversationFindFirst = jest.fn().mockResolvedValue({ id: CONVERSATION_ID });
  const skillFindFirst = jest.fn().mockResolvedValue({
    id: SKILL_ID,
    active: options.skillActive ?? true,
  });
  const requirementFindUnique = jest.fn().mockResolvedValue(
    options.existingLevel === undefined || options.existingLevel === null
      ? null
      : {
          tenantId: TENANT_ID,
          conversationId: CONVERSATION_ID,
          skillId: SKILL_ID,
          minLevel: options.existingLevel,
        },
  );
  const requirementCreate = jest.fn().mockResolvedValue({});
  const requirementUpdate = jest.fn().mockResolvedValue({});
  const requirementDeleteMany = jest.fn().mockResolvedValue({ count: options.removedCount ?? 1 });
  const auditLogCreate = jest.fn().mockResolvedValue({});
  const findMany = jest.fn().mockResolvedValue([]);
  const tx = {
    $queryRaw: queryRaw,
    conversation: { findFirst: conversationFindFirst },
    inboxSkill: { findFirst: skillFindFirst },
    conversationSkillRequirement: {
      findUnique: requirementFindUnique,
      create: requirementCreate,
      update: requirementUpdate,
      deleteMany: requirementDeleteMany,
    },
    auditLog: { create: auditLogCreate },
  };
  const transaction = jest.fn().mockImplementation(async (callback: (client: unknown) => Promise<unknown>) => callback(tx));
  const service = new InboxConversationSkillsService({
    $transaction: transaction,
    conversationSkillRequirement: { findMany },
  } as never);

  return {
    service,
    queryRaw,
    requirementCreate,
    requirementUpdate,
    requirementDeleteMany,
    auditLogCreate,
    findMany,
  };
}

describe("InboxConversationSkillsService", () => {
  it("creates an active skill requirement and audits the change", async () => {
    const { service, requirementCreate, auditLogCreate } = setup();

    await service.setRequirement(principal, CONVERSATION_ID, SKILL_ID, { minLevel: 3 });

    expect(requirementCreate).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT_ID,
        conversationId: CONVERSATION_ID,
        skillId: SKILL_ID,
        minLevel: 3,
      },
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "inbox.conversation.skill.required",
        entityType: "ConversationSkillRequirement",
        entityId: `${CONVERSATION_ID}:${SKILL_ID}`,
        metadata: { minLevel: 3 },
      }),
    });
  });

  it("treats setting the same minimum level as an idempotent no-op", async () => {
    const { service, requirementCreate, requirementUpdate, auditLogCreate } = setup({ existingLevel: 3 });

    await service.setRequirement(principal, CONVERSATION_ID, SKILL_ID, { minLevel: 3 });

    expect(requirementCreate).not.toHaveBeenCalled();
    expect(requirementUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("updates an existing requirement even after the skill is deactivated", async () => {
    const { service, requirementUpdate, auditLogCreate } = setup({ skillActive: false, existingLevel: 2 });

    await service.setRequirement(principal, CONVERSATION_ID, SKILL_ID, { minLevel: 4 });

    expect(requirementUpdate).toHaveBeenCalledWith({
      where: { conversationId_skillId: { conversationId: CONVERSATION_ID, skillId: SKILL_ID } },
      data: { minLevel: 4 },
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "inbox.conversation.skill.level.updated",
        metadata: { fromLevel: 2, toLevel: 4 },
      }),
    });
  });

  it("rejects a new requirement for an inactive skill", async () => {
    const { service, requirementCreate, auditLogCreate } = setup({ skillActive: false });

    await expect(service.setRequirement(principal, CONVERSATION_ID, SKILL_ID, { minLevel: 1 }))
      .rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(requirementCreate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("removes an existing requirement and audits the change", async () => {
    const { service, requirementDeleteMany, auditLogCreate } = setup({ removedCount: 1 });

    await service.removeRequirement(principal, CONVERSATION_ID, SKILL_ID);

    expect(requirementDeleteMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, conversationId: CONVERSATION_ID, skillId: SKILL_ID },
    });
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "inbox.conversation.skill.removed",
        entityId: `${CONVERSATION_ID}:${SKILL_ID}`,
      }),
    });
  });

  it("treats removing a missing requirement as a no-op", async () => {
    const { service, auditLogCreate } = setup({ removedCount: 0 });

    await service.removeRequirement(principal, CONVERSATION_ID, SKILL_ID);

    expect(auditLogCreate).not.toHaveBeenCalled();
  });
});
