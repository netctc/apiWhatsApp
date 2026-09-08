-- CreateEnum
CREATE TYPE "WhatsAppChannelStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('UNKNOWN', 'OPTED_IN', 'OPTED_OUT', 'REVOKED');

-- CreateTable
CREATE TABLE "WhatsAppChannel" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "providerPhoneNumberId" VARCHAR(64) NOT NULL,
    "wabaId" VARCHAR(64) NOT NULL,
    "displayPhoneNumber" VARCHAR(32),
    "verifiedName" VARCHAR(160),
    "status" "WhatsAppChannelStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "phoneNumber" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160),
    "language" VARCHAR(20),
    "timezone" VARCHAR(80),
    "metadata" JSONB,
    "optInStatus" "ConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "optInUpdatedAt" TIMESTAMP(3),
    "customerServiceWindowExpiresAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactConsentEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "source" VARCHAR(100) NOT NULL,
    "evidence" JSONB,
    "policyVersion" VARCHAR(50),
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactConsentEvent_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "channelId" UUID;
ALTER TABLE "Message" ADD COLUMN "contactId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppChannel_providerPhoneNumberId_key" ON "WhatsAppChannel"("providerPhoneNumberId");

-- Only one default WhatsApp channel is allowed per tenant.
CREATE UNIQUE INDEX "WhatsAppChannel_tenantId_default_key"
ON "WhatsAppChannel"("tenantId")
WHERE "isDefault" = true;

-- CreateIndex
CREATE INDEX "WhatsAppChannel_tenantId_status_isDefault_idx" ON "WhatsAppChannel"("tenantId", "status", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_tenantId_phoneNumber_key" ON "Contact"("tenantId", "phoneNumber");

-- CreateIndex
CREATE INDEX "Contact_tenantId_optInStatus_updatedAt_idx" ON "Contact"("tenantId", "optInStatus", "updatedAt");

-- CreateIndex
CREATE INDEX "Contact_tenantId_customerServiceWindowExpiresAt_idx" ON "Contact"("tenantId", "customerServiceWindowExpiresAt");

-- CreateIndex
CREATE INDEX "ContactConsentEvent_tenantId_contactId_occurredAt_idx" ON "ContactConsentEvent"("tenantId", "contactId", "occurredAt");

-- CreateIndex
CREATE INDEX "Message_channelId_createdAt_idx" ON "Message"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_contactId_createdAt_idx" ON "Message"("contactId", "createdAt");

-- AddForeignKey
ALTER TABLE "WhatsAppChannel" ADD CONSTRAINT "WhatsAppChannel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactConsentEvent" ADD CONSTRAINT "ContactConsentEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactConsentEvent" ADD CONSTRAINT "ContactConsentEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "WhatsAppChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
