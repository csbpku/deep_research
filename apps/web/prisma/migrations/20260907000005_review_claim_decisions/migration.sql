-- Human decisions are an append-only layer on top of immutable machine review
-- claims. A decision is always tied to the exact run and document revision.
CREATE TABLE "research_review_decisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "researchReviewRunId" UUID NOT NULL,
  "claimId" VARCHAR(160) NOT NULL,
  "revisionHash" CHAR(64) NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "reason" TEXT,
  "metadata" JSONB,
  "actorId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_review_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_review_decisions_run_fkey"
    FOREIGN KEY ("researchReviewRunId") REFERENCES "research_review_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "research_review_decisions_actor_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "research_review_decisions_action_check"
    CHECK ("action" IN (
      'confirm_support',
      'accept_uncertainty',
      'accept_conflict_risk',
      'mark_not_fact',
      'request_verification'
    ))
);

CREATE INDEX "research_review_decisions_run_claim_created_idx"
  ON "research_review_decisions" ("researchReviewRunId", "claimId", "createdAt" DESC);
CREATE INDEX "research_review_decisions_actor_created_idx"
  ON "research_review_decisions" ("actorId", "createdAt" DESC);
