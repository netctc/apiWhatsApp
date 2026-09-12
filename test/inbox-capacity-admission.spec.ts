import { jest } from "@jest/globals";
import { UnprocessableEntityException } from "@nestjs/common";
import { ConversationStatus } from "../src/generated/prisma/client.js";
import {
  assertAgentHasConversationCapacity,
  lockActiveAgentCapacity,
} from "../src/inbox/inbox-capacity-admission.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function setup(options: { active?: boolean; limit?: number | null; load?: number } = {}) {
  const queryRaw = jest.fn().mockResolvedValue([{ id: AGENT_ID }]);
  const inboxAgentFindFirst = jest.fn().mockResolvedValue(
    options.active === false
      ? null
      : {
          id: AGENT_ID,
          maxConcurrentConversations: options.limit === undefined ? null : options.limit,
        },
  );
  const conversationCount = jest.fn().mockResolvedValue(options.load ?? 0);
  const tx = {
    $queryRaw: queryRaw,
    inboxAgent: { findFirst: inboxAgentFindFirst },
    conversation: { count: conversationCount },
  };
  return { tx, queryRaw, inboxAgentFindFirst, conversationCount };
}

describe("inbox capacity admission", () => {
  it("locks the tenant agent row and returns its active capacity policy", async () => {
    const { tx, queryRaw, inboxAgentFindFirst } = setup({ limit: 4 });

    const agent = await lockActiveAgentCapacity(
      tx as never,
      TENANT_ID,
      AGENT_ID,
      "agent inactive",
    );

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(inboxAgentFindFirst).toHaveBeenCalledWith({
      where: { id: AGENT_ID, tenantId: TENANT_ID, active: true },
      select: { id: true, maxConcurrentConversations: true },
    });
    expect(agent).toEqual({ agentId: AGENT_ID, maxConcurrentConversations: 4 });
  });

  it("rejects a missing or inactive tenant agent after taking the admission lock", async () => {
    const { tx } = setup({ active: false });

    await expect(lockActiveAgentCapacity(tx as never, TENANT_ID, AGENT_ID, "agent inactive"))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("treats null capacity as unlimited without counting workload", async () => {
    const { tx, conversationCount } = setup();

    await expect(assertAgentHasConversationCapacity(
      tx as never,
      TENANT_ID,
      { agentId: AGENT_ID, maxConcurrentConversations: null },
      "full",
    )).resolves.toBeNull();

    expect(conversationCount).not.toHaveBeenCalled();
  });

  it("counts only OPEN/PENDING workload and admits below the configured limit", async () => {
    const { tx, conversationCount } = setup({ limit: 3, load: 2 });

    await expect(assertAgentHasConversationCapacity(
      tx as never,
      TENANT_ID,
      { agentId: AGENT_ID, maxConcurrentConversations: 3 },
      "full",
    )).resolves.toBe(2);

    expect(conversationCount).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        assignedAgentId: AGENT_ID,
        status: { in: [ConversationStatus.OPEN, ConversationStatus.PENDING] },
      },
    });
  });

  it("rejects zero capacity and workloads already at the configured limit", async () => {
    const zero = setup({ limit: 0, load: 0 });
    await expect(assertAgentHasConversationCapacity(
      zero.tx as never,
      TENANT_ID,
      { agentId: AGENT_ID, maxConcurrentConversations: 0 },
      "full",
    )).rejects.toBeInstanceOf(UnprocessableEntityException);

    const bounded = setup({ limit: 2, load: 2 });
    await expect(assertAgentHasConversationCapacity(
      bounded.tx as never,
      TENANT_ID,
      { agentId: AGENT_ID, maxConcurrentConversations: 2 },
      "full",
    )).rejects.toThrow("full");
  });
});
