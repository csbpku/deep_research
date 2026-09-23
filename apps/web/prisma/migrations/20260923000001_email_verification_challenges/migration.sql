CREATE TABLE "email_verification_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestIpHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_verification_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_verification_challenges_email_key"
    ON "email_verification_challenges"("email");
CREATE INDEX "email_verification_challenges_requestIpHash_sentAt_idx"
    ON "email_verification_challenges"("requestIpHash", "sentAt");
CREATE INDEX "email_verification_challenges_expiresAt_idx"
    ON "email_verification_challenges"("expiresAt");
