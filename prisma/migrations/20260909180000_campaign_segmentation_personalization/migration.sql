-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "Contact_tags_idx" ON "Contact" USING GIN ("tags");
