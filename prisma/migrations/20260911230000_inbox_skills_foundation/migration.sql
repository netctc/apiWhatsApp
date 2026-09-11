-- CreateTable
CREATE TABLE "InboxSkill" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxAgentSkill" (
    "tenantId" UUID NOT NULL,
    "skillId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxAgentSkill_pkey" PRIMARY KEY ("skillId", "agentId"),
    CONSTRAINT "InboxAgentSkill_level_check" CHECK ("level" >= 1 AND "level" <= 5)
);

-- Composite tenant ownership key used by proficiency foreign keys.
CREATE UNIQUE INDEX "InboxSkill_tenantId_id_key" ON "InboxSkill"("tenantId", "id");

-- Tenant skill indexes.
CREATE UNIQUE INDEX "InboxSkill_tenantId_name_key" ON "InboxSkill"("tenantId", "name");
CREATE INDEX "InboxSkill_tenantId_active_name_idx" ON "InboxSkill"("tenantId", "active", "name");

-- Proficiency lookup indexes.
CREATE INDEX "InboxAgentSkill_tenantId_agentId_level_idx" ON "InboxAgentSkill"("tenantId", "agentId", "level");
CREATE INDEX "InboxAgentSkill_tenantId_skillId_level_idx" ON "InboxAgentSkill"("tenantId", "skillId", "level");

-- Skill tenant ownership.
ALTER TABLE "InboxSkill" ADD CONSTRAINT "InboxSkill_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite foreign keys make cross-tenant proficiency assignments impossible at the database boundary.
ALTER TABLE "InboxAgentSkill" ADD CONSTRAINT "InboxAgentSkill_tenantId_skillId_fkey"
    FOREIGN KEY ("tenantId", "skillId") REFERENCES "InboxSkill"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InboxAgentSkill" ADD CONSTRAINT "InboxAgentSkill_tenantId_agentId_fkey"
    FOREIGN KEY ("tenantId", "agentId") REFERENCES "InboxAgent"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
