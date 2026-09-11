-- Additive only: no changes to messages, conversations or provider templates.
CREATE TABLE "InboxCannedResponse" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "shortcut" VARCHAR(32) NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InboxCannedResponse_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InboxCannedResponse_shortcut_check" CHECK ("shortcut" ~ '^[a-z][a-z0-9_-]{0,31}$'),
    CONSTRAINT "InboxCannedResponse_title_check" CHECK (char_length("title") BETWEEN 1 AND 100),
    CONSTRAINT "InboxCannedResponse_body_check" CHECK (char_length("body") BETWEEN 1 AND 4096),
    CONSTRAINT "InboxCannedResponse_revision_check" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "InboxCannedResponse_tenantId_shortcut_key" ON "InboxCannedResponse"("tenantId", "shortcut");
CREATE INDEX "InboxCannedResponse_tenantId_active_createdAt_id_idx" ON "InboxCannedResponse"("tenantId", "active", "createdAt", "id");
CREATE INDEX "InboxCannedResponse_tenantId_createdAt_id_idx" ON "InboxCannedResponse"("tenantId", "createdAt", "id");
ALTER TABLE "InboxCannedResponse" ADD CONSTRAINT "InboxCannedResponse_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
