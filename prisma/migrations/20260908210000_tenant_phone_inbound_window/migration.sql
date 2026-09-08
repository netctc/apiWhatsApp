-- AlterEnum
ALTER TYPE "MessageStatus" ADD VALUE 'RECEIVED';

-- AlterEnum
ALTER TYPE "MessageType" ADD VALUE 'UNKNOWN';

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "serviceWindowExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "senderId" UUID;
ALTER TABLE "Message" ADD COLUMN "providerTimestamp" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WhatsAppPhoneNumber" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerPhoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT,
    "displayPhoneNumber" TEXT,
    "verifiedName" TEXT,
    "credentialRef" TEXT NOT NULL,
    "rateLimitPerSecond" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppPhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppPhoneNumber_providerPhoneNumberId_key" ON "WhatsAppPhoneNumber"("providerPhoneNumberId");

-- CreateIndex
CREATE INDEX "WhatsAppPhoneNumber_tenantId_active_isDefault_idx" ON "WhatsAppPhoneNumber"("tenantId", "active", "isDefault");

-- Enforce at most one active default sender per tenant.
CREATE UNIQUE INDEX "WhatsAppPhoneNumber_active_default_per_tenant_key"
ON "WhatsAppPhoneNumber"("tenantId")
WHERE "active" = true AND "isDefault" = true;

-- CreateIndex
CREATE INDEX "Contact_tenantId_serviceWindowExpiresAt_idx" ON "Contact"("tenantId", "serviceWindowExpiresAt");

-- CreateIndex
CREATE INDEX "Message_tenantId_senderId_createdAt_idx" ON "Message"("tenantId", "senderId", "createdAt");

-- AddForeignKey
ALTER TABLE "WhatsAppPhoneNumber" ADD CONSTRAINT "WhatsAppPhoneNumber_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "WhatsAppPhoneNumber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
