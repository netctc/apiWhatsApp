-- CreateTable
CREATE TABLE "InboxTeam" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxTeamMember" (
    "tenantId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxTeamMember_pkey" PRIMARY KEY ("teamId", "agentId")
);

-- Composite tenant ownership keys used by membership foreign keys.
CREATE UNIQUE INDEX "InboxAgent_tenantId_id_key" ON "InboxAgent"("tenantId", "id");
CREATE UNIQUE INDEX "InboxTeam_tenantId_id_key" ON "InboxTeam"("tenantId", "id");

-- Tenant team indexes.
CREATE UNIQUE INDEX "InboxTeam_tenantId_name_key" ON "InboxTeam"("tenantId", "name");
CREATE INDEX "InboxTeam_tenantId_active_name_idx" ON "InboxTeam"("tenantId", "active", "name");

-- Membership lookup indexes.
CREATE INDEX "InboxTeamMember_tenantId_agentId_idx" ON "InboxTeamMember"("tenantId", "agentId");
CREATE INDEX "InboxTeamMember_tenantId_teamId_createdAt_idx" ON "InboxTeamMember"("tenantId", "teamId", "createdAt");

-- Team tenant ownership.
ALTER TABLE "InboxTeam" ADD CONSTRAINT "InboxTeam_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite foreign keys make cross-tenant membership impossible at the database boundary.
ALTER TABLE "InboxTeamMember" ADD CONSTRAINT "InboxTeamMember_tenantId_teamId_fkey"
    FOREIGN KEY ("tenantId", "teamId") REFERENCES "InboxTeam"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InboxTeamMember" ADD CONSTRAINT "InboxTeamMember_tenantId_agentId_fkey"
    FOREIGN KEY ("tenantId", "agentId") REFERENCES "InboxAgent"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
