-- CreateTable
CREATE TABLE "ClientWebhookEndpoint" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "secretIv" TEXT NOT NULL,
    "secretTag" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientWebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientWebhookDelivery" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "sourceEventKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingLeaseUntil" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "responseStatus" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientWebhookEndpoint_tenantId_name_key" ON "ClientWebhookEndpoint"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ClientWebhookEndpoint_tenantId_active_updatedAt_idx" ON "ClientWebhookEndpoint"("tenantId", "active", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClientWebhookDelivery_endpointId_sourceEventKey_key" ON "ClientWebhookDelivery"("endpointId", "sourceEventKey");

-- CreateIndex
CREATE INDEX "ClientWebhookDelivery_deliveredAt_failedAt_nextAttemptAt_processingLeaseUntil_createdAt_idx" ON "ClientWebhookDelivery"("deliveredAt", "failedAt", "nextAttemptAt", "processingLeaseUntil", "createdAt");

-- CreateIndex
CREATE INDEX "ClientWebhookDelivery_tenantId_createdAt_idx" ON "ClientWebhookDelivery"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ClientWebhookDelivery_endpointId_createdAt_idx" ON "ClientWebhookDelivery"("endpointId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClientWebhookEndpoint" ADD CONSTRAINT "ClientWebhookEndpoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientWebhookDelivery" ADD CONSTRAINT "ClientWebhookDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientWebhookDelivery" ADD CONSTRAINT "ClientWebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "ClientWebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
