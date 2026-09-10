-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'PENDING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ConversationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "InboxAgent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboxAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "assignedAgentId" UUID,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "ConversationPriority" NOT NULL DEFAULT 'NORMAL',
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationNote" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "createdByApiKeyId" UUID,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationNote_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "conversationId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "InboxAgent_tenantId_externalId_key" ON "InboxAgent"("tenantId", "externalId");

-- CreateIndex
CREATE INDEX "InboxAgent_tenantId_active_name_idx" ON "InboxAgent"("tenantId", "active", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_tenantId_senderId_contactId_key" ON "Conversation"("tenantId", "senderId", "contactId");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_status_lastMessageAt_idx" ON "Conversation"("tenantId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_assignedAgentId_status_lastMessageAt_idx" ON "Conversation"("tenantId", "assignedAgentId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_priority_lastMessageAt_idx" ON "Conversation"("tenantId", "priority", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_contactId_lastMessageAt_idx" ON "Conversation"("contactId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "ConversationNote_tenantId_conversationId_createdAt_idx" ON "ConversationNote"("tenantId", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_tenantId_conversationId_createdAt_idx" ON "Message"("tenantId", "conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "InboxAgent" ADD CONSTRAINT "InboxAgent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "WhatsAppPhoneNumber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "InboxAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_createdByApiKeyId_fkey" FOREIGN KEY ("createdByApiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
