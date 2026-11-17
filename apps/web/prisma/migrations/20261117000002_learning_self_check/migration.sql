CREATE TABLE "learning_self_check" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "researchId" UUID NOT NULL,
    "questionKey" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "learning_self_check_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "learning_self_check_userId_researchId_questionKey_key"
  ON "learning_self_check"("userId", "researchId", "questionKey");
CREATE INDEX "learning_self_check_userId_rating_idx" ON "learning_self_check"("userId", "rating");
ALTER TABLE "learning_self_check" ADD CONSTRAINT "learning_self_check_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learning_self_check" ADD CONSTRAINT "learning_self_check_researchId_fkey"
  FOREIGN KEY ("researchId") REFERENCES "researches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
