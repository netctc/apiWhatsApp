ALTER TABLE "InboxAgent"
ADD COLUMN "maxConcurrentConversations" INTEGER;

ALTER TABLE "InboxAgent"
ADD CONSTRAINT "InboxAgent_maxConcurrentConversations_check"
CHECK (
  "maxConcurrentConversations" IS NULL
  OR (
    "maxConcurrentConversations" >= 0
    AND "maxConcurrentConversations" <= 10000
  )
);
