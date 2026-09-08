-- A published AI research is a stable reviewed artifact. Edits create a new
-- draft revision instead of mutating the public row in place.
ALTER TABLE "researches"
  ADD COLUMN "supersedesResearchId" UUID;

CREATE INDEX "researches_supersedesResearchId_idx"
  ON "researches"("supersedesResearchId");

ALTER TABLE "researches"
  ADD CONSTRAINT "researches_supersedesResearchId_fkey"
  FOREIGN KEY ("supersedesResearchId")
  REFERENCES "researches"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
