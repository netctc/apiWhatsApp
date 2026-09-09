-- CreateEnum
CREATE TYPE "MessageTrafficClass" AS ENUM ('OTP', 'TRANSACTIONAL', 'MARKETING');

-- AlterTable
ALTER TABLE "Message"
ADD COLUMN "trafficClass" "MessageTrafficClass" NOT NULL DEFAULT 'TRANSACTIONAL';

-- CreateIndex
CREATE INDEX "Message_tenantId_trafficClass_createdAt_idx" ON "Message"("tenantId", "trafficClass", "createdAt");

-- CreateIndex
CREATE INDEX "Message_trafficClass_status_processingLeaseUntil_createdAt_idx" ON "Message"("trafficClass", "status", "processingLeaseUntil", "createdAt");
