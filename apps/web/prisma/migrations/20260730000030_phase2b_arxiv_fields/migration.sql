-- Phase 2B — Radar Deep-Dive: arxiv paper parsed structure
--
-- Adds fields for the AI-generated TL;DR, structured sections extracted
-- from the PDF, and figure metadata. Authors come from arxiv Atom XML
-- (parsed at sync time, persisted as String[]).

ALTER TABLE "summaries"
  ADD COLUMN "tldr"      VARCHAR(500),
  ADD COLUMN "sections"  JSONB,
  ADD COLUMN "figures"   JSONB,
  ADD COLUMN "authors"   TEXT[] NOT NULL DEFAULT '{}';

-- Backfill authors from existing arxiv-sourced summaries. Best-effort;
-- newer rows get authors populated at sync time by sync_runner.py.
-- We use LATERAL join to satisfy "set-returning in top-level FROM".
UPDATE "summaries" s
   SET "authors" = COALESCE((
     SELECT array_agg(DISTINCT trim(m[1]))
       FROM regexp_matches(s."originalMarkdown", 'Authors?:\s*([^\n.]+)', 'g') AS m
   ), '{}')
 WHERE s."originalKind" = 'arxiv'
   AND cardinality(s."authors") = 0
   AND s."originalMarkdown" IS NOT NULL
   AND s."originalMarkdown" ~* 'Authors?:\s';