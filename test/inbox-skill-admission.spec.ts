import { jest } from "@jest/globals";
import { UnprocessableEntityException } from "@nestjs/common";
import {
  assertAgentMeetsConversationSkills,
  filterAgentsByConversationSkills,
} from "../src/inbox/inbox-skill-admission.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "33333333-3333-4333-8333-333333333333";
const AGENT_B = "44444444-4444-4444-8444-444444444444";
const SKILL_A = "55555555-5555-4555-8555-555555555555";
const SKILL_B = "66666666-6666-4666-8666-666666666666";

function transactionWith(rows: unknown[][]) {
  const queryRaw = jest.fn();
  for (const row of rows) queryRaw.mockResolvedValueOnce(row);
  return { transaction: { $queryRaw: queryRaw } as never, queryRaw };
}

describe("conversation skill admission", () => {
  it("accepts an agent that satisfies every active requirement at or above the minimum", async () => {
    const { transaction, queryRaw } = transactionWith([
      [
        { skillId: SKILL_A, minLevel: 2, active: true },
        { skillId: SKILL_B, minLevel: 4, active: true },
      ],
      [
        { agentId: AGENT_A, skillId: SKILL_A, level: 3 },
        { agentId: AGENT_A, skillId: SKILL_B, level: 4 },
      ],
    ]);

    await expect(assertAgentMeetsConversationSkills(
      transaction,
      TENANT_ID,
      CONVERSATION_ID,
      AGENT_A,
      "mismatch",
    )).resolves.toBe(2);

    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing or below-minimum proficiency", async () => {
    const { transaction } = transactionWith([
      [
        { skillId: SKILL_A, minLevel: 2, active: true },
        { skillId: SKILL_B, minLevel: 4, active: true },
      ],
      [{ agentId: AGENT_A, skillId: SKILL_A, level: 2 }],
    ]);

    await expect(assertAgentMeetsConversationSkills(
      transaction,
      TENANT_ID,
      CONVERSATION_ID,
      AGENT_A,
      "agent lacks required skills",
    )).rejects.toThrow("agent lacks required skills");
  });

  it("fails admission closed when a required skill is inactive", async () => {
    const { transaction, queryRaw } = transactionWith([
      [{ skillId: SKILL_A, minLevel: 1, active: false }],
    ]);

    await expect(assertAgentMeetsConversationSkills(
      transaction,
      TENANT_ID,
      CONVERSATION_ID,
      AGENT_A,
      "mismatch",
    )).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("treats a conversation without requirements as unrestricted", async () => {
    const { transaction, queryRaw } = transactionWith([[]]);

    await expect(assertAgentMeetsConversationSkills(
      transaction,
      TENANT_ID,
      CONVERSATION_ID,
      AGENT_A,
      "mismatch",
    )).resolves.toBe(0);

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("filters team candidates using all-of minimum levels while preserving input order", async () => {
    const { transaction } = transactionWith([
      [
        { skillId: SKILL_A, minLevel: 2, active: true },
        { skillId: SKILL_B, minLevel: 3, active: true },
      ],
      [
        { agentId: AGENT_A, skillId: SKILL_A, level: 2 },
        { agentId: AGENT_A, skillId: SKILL_B, level: 3 },
        { agentId: AGENT_B, skillId: SKILL_A, level: 5 },
        { agentId: AGENT_B, skillId: SKILL_B, level: 2 },
      ],
    ]);

    await expect(filterAgentsByConversationSkills(
      transaction,
      TENANT_ID,
      CONVERSATION_ID,
      [AGENT_A, AGENT_B],
    )).resolves.toEqual({ agentIds: [AGENT_A], requiredSkills: 2 });
  });

  it("returns all candidates without querying proficiencies when there are no requirements", async () => {
    const { transaction, queryRaw } = transactionWith([[]]);

    await expect(filterAgentsByConversationSkills(
      transaction,
      TENANT_ID,
      CONVERSATION_ID,
      [AGENT_A, AGENT_B],
    )).resolves.toEqual({ agentIds: [AGENT_A, AGENT_B], requiredSkills: 0 });

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
