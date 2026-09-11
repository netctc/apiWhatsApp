import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";

type SkillRequirement = {
  skillId: string;
  minLevel: number;
};

type SkillRequirementRow = SkillRequirement & {
  active: boolean;
};

type ProficiencyRow = {
  agentId: string;
  skillId: string;
  level: number;
};

export async function assertAgentMeetsConversationSkills(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  conversationId: string,
  agentId: string,
  mismatchMessage: string,
): Promise<number> {
  const requirements = await lockRequirements(transaction, tenantId, conversationId);
  if (requirements.length === 0) return 0;
  assertRequirementsActive(requirements);

  const proficiencies = await lockProficiencies(
    transaction,
    tenantId,
    [agentId],
    requirements.map((requirement) => requirement.skillId),
  );
  const bySkill = new Map(proficiencies.map((row) => [row.skillId, row.level]));
  if (requirements.some((requirement) => (bySkill.get(requirement.skillId) ?? 0) < requirement.minLevel)) {
    throw new UnprocessableEntityException(mismatchMessage);
  }
  return requirements.length;
}

export async function filterAgentsByConversationSkills(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  conversationId: string,
  agentIds: string[],
): Promise<{ agentIds: string[]; requiredSkills: number }> {
  const requirements = await lockRequirements(transaction, tenantId, conversationId);
  if (requirements.length === 0) return { agentIds, requiredSkills: 0 };
  assertRequirementsActive(requirements);
  if (agentIds.length === 0) return { agentIds: [], requiredSkills: requirements.length };

  const proficiencies = await lockProficiencies(
    transaction,
    tenantId,
    agentIds,
    requirements.map((requirement) => requirement.skillId),
  );
  const byAgent = new Map<string, Map<string, number>>();
  for (const row of proficiencies) {
    let skills = byAgent.get(row.agentId);
    if (!skills) {
      skills = new Map();
      byAgent.set(row.agentId, skills);
    }
    skills.set(row.skillId, row.level);
  }

  return {
    agentIds: agentIds.filter((agentId) => {
      const skills = byAgent.get(agentId);
      return requirements.every(
        (requirement) => (skills?.get(requirement.skillId) ?? 0) >= requirement.minLevel,
      );
    }),
    requiredSkills: requirements.length,
  };
}

async function lockRequirements(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  conversationId: string,
): Promise<SkillRequirementRow[]> {
  return transaction.$queryRaw<SkillRequirementRow[]>(Prisma.sql`
    SELECT requirement."skillId", requirement."minLevel", skill."active"
    FROM "ConversationSkillRequirement" AS requirement
    INNER JOIN "InboxSkill" AS skill
      ON skill."tenantId" = requirement."tenantId"
      AND skill."id" = requirement."skillId"
    WHERE requirement."tenantId" = ${tenantId}::uuid
      AND requirement."conversationId" = ${conversationId}::uuid
    ORDER BY requirement."skillId" ASC
    FOR SHARE OF skill
  `);
}

async function lockProficiencies(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  agentIds: string[],
  skillIds: string[],
): Promise<ProficiencyRow[]> {
  if (agentIds.length === 0 || skillIds.length === 0) return [];
  const agents = Prisma.join(agentIds.map((agentId) => Prisma.sql`${agentId}::uuid`));
  const skills = Prisma.join(skillIds.map((skillId) => Prisma.sql`${skillId}::uuid`));
  return transaction.$queryRaw<ProficiencyRow[]>(Prisma.sql`
    SELECT "agentId", "skillId", "level"
    FROM "InboxAgentSkill"
    WHERE "tenantId" = ${tenantId}::uuid
      AND "agentId" IN (${agents})
      AND "skillId" IN (${skills})
    ORDER BY "agentId" ASC, "skillId" ASC
    FOR SHARE
  `);
}

function assertRequirementsActive(requirements: SkillRequirementRow[]): void {
  if (requirements.some((requirement) => !requirement.active)) {
    throw new UnprocessableEntityException("Conversation has inactive required inbox skills");
  }
}
