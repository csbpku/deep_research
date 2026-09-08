-- Keep the import queue's lease lifecycle aligned with the shared job runner.
ALTER TABLE "content_import_jobs"
ADD COLUMN "startedAt" TIMESTAMPTZ(3);
