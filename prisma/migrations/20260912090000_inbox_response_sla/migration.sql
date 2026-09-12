ALTER TABLE "InboxTeam"
ADD COLUMN "responseSlaMinutes" INTEGER;

ALTER TABLE "Conversation"
ADD COLUMN "responseSlaStartedAt" TIMESTAMP(3),
ADD COLUMN "responseSlaDueAt" TIMESTAMP(3),
ADD COLUMN "responseSlaRespondedAt" TIMESTAMP(3);

ALTER TABLE "InboxTeam"
ADD CONSTRAINT "InboxTeam_responseSlaMinutes_check"
CHECK (
  "responseSlaMinutes" IS NULL
  OR ("responseSlaMinutes" >= 1 AND "responseSlaMinutes" <= 10080)
);

ALTER TABLE "Conversation"
ADD CONSTRAINT "Conversation_responseSlaCycle_check"
CHECK (
  (
    "responseSlaStartedAt" IS NULL
    AND "responseSlaDueAt" IS NULL
    AND "responseSlaRespondedAt" IS NULL
  )
  OR (
    "responseSlaStartedAt" IS NOT NULL
    AND "responseSlaDueAt" IS NOT NULL
    AND "responseSlaDueAt" > "responseSlaStartedAt"
    AND (
      "responseSlaRespondedAt" IS NULL
      OR "responseSlaRespondedAt" >= "responseSlaStartedAt"
    )
  )
);

CREATE INDEX "Conversation_tenantId_status_responseSlaDueAt_idx"
ON "Conversation"("tenantId", "status", "responseSlaDueAt");

CREATE FUNCTION "applyConversationTeamResponseSla"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  sla_minutes INTEGER;
  cycle_started_at TIMESTAMP(3);
BEGIN
  SELECT "responseSlaMinutes"
  INTO sla_minutes
  FROM "InboxTeam"
  WHERE "tenantId" = NEW."tenantId"
    AND "id" = NEW."teamId";

  IF sla_minutes IS NULL THEN
    RETURN NEW;
  END IF;

  cycle_started_at := CURRENT_TIMESTAMP;

  UPDATE "Conversation"
  SET
    "responseSlaStartedAt" = cycle_started_at,
    "responseSlaDueAt" = cycle_started_at + (sla_minutes * INTERVAL '1 minute'),
    "responseSlaRespondedAt" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "tenantId" = NEW."tenantId"
    AND "id" = NEW."conversationId"
    AND "status" IN ('OPEN'::"ConversationStatus", 'PENDING'::"ConversationStatus")
    AND "lastInboundAt" IS NOT NULL
    AND ("lastOutboundAt" IS NULL OR "lastInboundAt" > "lastOutboundAt")
    AND ("responseSlaDueAt" IS NULL OR "responseSlaRespondedAt" IS NOT NULL);

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ConversationTeamAssignment_response_sla_trigger"
AFTER INSERT OR UPDATE OF "teamId"
ON "ConversationTeamAssignment"
FOR EACH ROW
EXECUTE FUNCTION "applyConversationTeamResponseSla"();
