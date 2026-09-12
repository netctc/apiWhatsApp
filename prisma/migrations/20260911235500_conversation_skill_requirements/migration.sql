-- CreateTable
CREATE TABLE "ConversationSkillRequirement" (
    "tenantId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "skillId" UUID NOT NULL,
    "minLevel" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationSkillRequirement_pkey" PRIMARY KEY ("conversationId", "skillId"),
    CONSTRAINT "ConversationSkillRequirement_minLevel_check" CHECK ("minLevel" >= 1 AND "minLevel" <= 5)
);

-- Requirement lookups for routing/admission and conversation detail.
CREATE INDEX "ConversationSkillRequirement_tenantId_skillId_minLevel_idx"
    ON "ConversationSkillRequirement"("tenantId", "skillId", "minLevel");
CREATE INDEX "ConversationSkillRequirement_tenantId_conversationId_idx"
    ON "ConversationSkillRequirement"("tenantId", "conversationId");

-- Composite foreign keys make cross-tenant conversation/skill requirements impossible.
ALTER TABLE "ConversationSkillRequirement" ADD CONSTRAINT "ConversationSkillRequirement_tenantId_conversationId_fkey"
    FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationSkillRequirement" ADD CONSTRAINT "ConversationSkillRequirement_tenantId_skillId_fkey"
    FOREIGN KEY ("tenantId", "skillId") REFERENCES "InboxSkill"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
