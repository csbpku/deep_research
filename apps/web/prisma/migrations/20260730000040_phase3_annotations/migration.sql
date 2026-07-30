-- Phase 3 — Radar annotation model (highlight + comment + star).
--
-- radar_annotations stores per-user text selection anchors against
-- the canonical originalMarkdown text. radar_annotation_stars is
-- a per-user-per-annotation toggle (same ergonomics as comment_stars).

CREATE TABLE "radar_annotations" (
  "id"           UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "summaryId"    UUID NOT NULL REFERENCES "summaries"("id") ON DELETE CASCADE,
  "authorId"     UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "kind"         VARCHAR(16) NOT NULL,  -- highlight | comment | highlight_comment
  "quote"        TEXT NOT NULL,          -- exact selected text (W3C TextQuoteSelector)
  "startOffset"  INTEGER NOT NULL,       -- char offset in originalMarkdown
  "endOffset"    INTEGER NOT NULL,
  "body"         VARCHAR(2000),          -- optional comment text
  "parentId"     UUID REFERENCES "radar_annotations"("id") ON DELETE SET NULL,
  "color"        VARCHAR(16),
  "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX "radar_annotations_summaryId_kind_idx"
  ON "radar_annotations" ("summaryId", "kind");

CREATE INDEX "radar_annotations_summaryId_startOffset_idx"
  ON "radar_annotations" ("summaryId", "startOffset");

CREATE TABLE "radar_annotation_stars" (
  "annotationId" UUID NOT NULL REFERENCES "radar_annotations"("id") ON DELETE CASCADE,
  "userId"       UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("annotationId", "userId")
);
