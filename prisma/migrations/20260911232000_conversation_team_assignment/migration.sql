-- Composite conversation ownership key used by the assignment foreign key.
CREATE UNIQUE INDEX "Conversation_tenantId_id_key" ON "Conversation"("tenantId", "id");

-- CreateTable
CREATE TABLE "ConversationTeamAssignment" (
    "tenantId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationTeamAssignment_pkey" PRIMARY KEY ("conversationId")
);

-- Prisma requires the exact relation fields to be unique for a one-to-one relation.
-- conversationId is already globally unique through the primary key; this composite key
-- keeps the Prisma model and database relation contract identical.
CREATE UNIQUE INDEX "ConversationTeamAssignment_tenantId_conversationId_key"
    ON "ConversationTeamAssignment"("tenantId", "conversationId");

CREATE INDEX "ConversationTeamAssignment_tenantId_teamId_updatedAt_idx"
    ON "ConversationTeamAssignment"("tenantId", "teamId", "updatedAt");

-- Composite tenant-safe ownership constraints.
ALTER TABLE "ConversationTeamAssignment" ADD CONSTRAINT "ConversationTeamAssignment_tenantId_conversationId_fkey"
    FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationTeamAssignment" ADD CONSTRAINT "ConversationTeamAssignment_tenantId_teamId_fkey"
    FOREIGN KEY ("tenantId", "teamId") REFERENCES "InboxTeam"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
