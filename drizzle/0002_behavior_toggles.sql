ALTER TABLE "servers" ADD COLUMN "completion_delay_seconds" INTEGER NOT NULL DEFAULT 3;

UPDATE "servers"
SET "completion_delay_seconds" = 3
WHERE "completion_delay_seconds" IS NULL;

UPDATE "servers"
SET "max_context_messages" = 50
WHERE "max_context_messages" > 50;
