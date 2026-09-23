-- Browser reading saves are retried by the extension when a network response
-- is lost. Nullable keys preserve the existing manual/research rows while the
-- composite unique constraint makes the explicit save operation idempotent
-- per user.
ALTER TABLE "researches"
  ADD COLUMN "readingSaveKey" UUID;

CREATE UNIQUE INDEX "researches_authorId_readingSaveKey_key"
  ON "researches" ("authorId", "readingSaveKey");
