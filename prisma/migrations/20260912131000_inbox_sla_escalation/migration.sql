ALTER TABLE "Conversation"
ADD COLUMN "responseSlaEscalatedAt" TIMESTAMP(3);

ALTER TABLE "Conversation"
DROP CONSTRAINT "Conversation_responseSlaCycle_check";

ALTER TABLE "Conversation"
ADD CONSTRAINT "Conversation_responseSlaCycle_check"
CHECK (
  (
    "responseSlaStartedAt" IS NULL
    AND "responseSlaDueAt" IS NULL
    AND "responseSlaRespondedAt" IS NULL
    AND "responseSlaEscalatedAt" IS NULL
  )
  OR (
    "responseSlaStartedAt" IS NOT NULL
    AND "responseSlaDueAt" IS NOT NULL
    AND "responseSlaDueAt" > "responseSlaStartedAt"
    AND (
      "responseSlaRespondedAt" IS NULL
      OR "responseSlaRespondedAt" >= "responseSlaStartedAt"
    )
    AND (
      "responseSlaEscalatedAt" IS NULL
      OR "responseSlaEscalatedAt" >= "responseSlaDueAt"
    )
  )
);

CREATE INDEX "Conversation_status_responseSlaDueAt_responseSlaEscalatedAt_idx"
ON "Conversation"("status", "responseSlaDueAt", "responseSlaEscalatedAt");

CREATE OR REPLACE FUNCTION "applyConversationTeamResponseSla"()
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
    "responseSlaEscalatedAt" = NULL,
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
