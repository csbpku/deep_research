-- Track the most recent successful topic synthesis separately from synthesisGeneratedAt,
-- so failure runs can null synthesisGeneratedAt without losing the "last successful update" signal.

ALTER TABLE "topics"
  ADD COLUMN "lastSynthesisSuccessAt" TIMESTAMPTZ(3);
