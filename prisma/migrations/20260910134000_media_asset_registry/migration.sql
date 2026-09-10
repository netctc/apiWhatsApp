-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "providerMediaId" TEXT,
    "category" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "scanMode" TEXT NOT NULL,
    "scanStatus" TEXT NOT NULL,
    "providerUploadedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_providerMediaId_key" ON "MediaAsset"("providerMediaId");

-- CreateIndex
CREATE INDEX "MediaAsset_tenantId_createdAt_idx" ON "MediaAsset"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_tenantId_expiresAt_createdAt_idx" ON "MediaAsset"("tenantId", "expiresAt", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_tenantId_senderId_createdAt_idx" ON "MediaAsset"("tenantId", "senderId", "createdAt");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "WhatsAppPhoneNumber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
