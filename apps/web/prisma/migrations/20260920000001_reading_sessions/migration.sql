-- Explicit opt-in synchronization of bounded browser-reader session metadata.
-- Full page text, translation cache and image bytes remain local to the extension.
CREATE TABLE "reading_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "documentKey" CHAR(64) NOT NULL,
    "documentUrl" VARCHAR(2048) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "documentVersion" VARCHAR(128),
    "state" JSONB NOT NULL,
    "lastSyncKey" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reading_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reading_sessions_userId_clientId_documentKey_key"
    ON "reading_sessions"("userId", "clientId", "documentKey");
CREATE INDEX "reading_sessions_userId_updatedAt_idx"
    ON "reading_sessions"("userId", "updatedAt" DESC);

ALTER TABLE "reading_sessions"
    ADD CONSTRAINT "reading_sessions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
