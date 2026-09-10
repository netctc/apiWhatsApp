-- AlterTable
ALTER TABLE "MediaAsset"
ADD COLUMN "storageMode" TEXT NOT NULL DEFAULT 'DISABLED',
ADD COLUMN "storageKey" TEXT,
ADD COLUMN "storedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_tenantId_storageKey_key" ON "MediaAsset"("tenantId", "storageKey");

-- CreateIndex
CREATE INDEX "MediaAsset_expiresAt_createdAt_idx" ON "MediaAsset"("expiresAt", "createdAt");
