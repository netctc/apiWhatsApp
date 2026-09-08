-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "wabaId" TEXT NOT NULL,
    "providerTemplateId" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT NOT NULL,
    "components" JSONB,
    "qualityScore" JSONB,
    "rejectionReason" TEXT,
    "providerPayload" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_providerTemplateId_key" ON "MessageTemplate"("providerTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_tenantId_wabaId_name_language_key" ON "MessageTemplate"("tenantId", "wabaId", "name", "language");

-- CreateIndex
CREATE INDEX "MessageTemplate_tenantId_status_category_idx" ON "MessageTemplate"("tenantId", "status", "category");

-- CreateIndex
CREATE INDEX "MessageTemplate_tenantId_wabaId_updatedAt_idx" ON "MessageTemplate"("tenantId", "wabaId", "updatedAt");

-- CreateIndex
CREATE INDEX "WhatsAppPhoneNumber_wabaId_tenantId_idx" ON "WhatsAppPhoneNumber"("wabaId", "tenantId");

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
