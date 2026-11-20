ALTER TABLE "learning_self_check"
  ADD COLUMN "firstMissedAt" TIMESTAMPTZ(3);

UPDATE "learning_self_check"
SET "firstMissedAt" = "updatedAt"
WHERE rating IN ('unsure', 'missed');
