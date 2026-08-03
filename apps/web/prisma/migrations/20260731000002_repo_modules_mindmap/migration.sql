-- Phase 2C — Radar Deep-Dive: GitHub repo modules + mindmap
--
-- Adds two fields populated by enrichment_worker._generate_repo_modules():
--
--   modules: jsonb — OpenDeepWiki-style module catalog
--            Schema borrowed from AIDotNet/OpenDeepWiki catalog-generator.md.
--            Shape:
--              {items: [{title, path, order, children: [...]}]}
--
--   mindmap: text — 3-level markdown outline with `:path/to/file` links
--            for click-to-source. Patterned after OpenDeepWiki
--            mindmap-generator.md.

ALTER TABLE "summaries"
  ADD COLUMN "modules" JSONB,
  ADD COLUMN "mindmap" TEXT;