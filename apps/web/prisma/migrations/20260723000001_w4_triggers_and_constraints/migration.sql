-- Week 4 [db] follow-up: search_docs tsvector + trigger + share_submissions constraints
-- 配套: schema.prisma 已添加 model (search_docs / share_submissions)
-- 契约: docs/contracts/fetch-url-safety.md, docs/IMPLEMENTATION_PLAN.md §六
-- 注意: zhparser 装机本机受阻（PG16 SDK14 vs SDK26 + scws 未装），本 migration 用 simple 字典。
--      W5 装上 zhparser 后加新 migration：CREATE EXTENSION + 重建触发器换 chinese_zh。
--
-- 必须执行顺序：
--   Prisma db push 已建 search_docs / share_submissions / 用户反向关系（先）
--   本文件补：tsvector 列 + trigger + GIN 索引 + share_submissions CHECK/partial unique（后）

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. tsvector 列（Prisma 不支持原生 tsvector）
-- ─────────────────────────────────────────────────────────────

ALTER TABLE search_docs
  ADD COLUMN IF NOT EXISTS doc_tsv tsvector;

-- ─────────────────────────────────────────────────────────────
-- 2. 维护 trigger：summary / research 写入/更新/删除时同步 search_docs
--    - 同一事务内同步（PLAN §六 验收：发布后搜索结果立即一致）
--    - 草稿（status='draft' / summaries.status='candidate' 且未发布）不写
--    - 已发布（summaries.status='published' 且 publishedAt 非空，
--              researches.status='published'）才写
--    - 删除/归档时级联删除 search_docs
--    - simple 字典（W5 zhparser 装机后替换为 chinese_zh）
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sync_search_docs_from_summary() RETURNS trigger AS $$
DECLARE
  v_title text;
  v_snippet text;
  v_published_at timestamptz;
  v_should_index boolean;
BEGIN
  v_should_index := (NEW.status = 'published' AND NEW."publishedAt" IS NOT NULL);

  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_docs WHERE type = 'summary' AND "refId" = OLD.id;
    RETURN OLD;
  END IF;

  IF NOT v_should_index THEN
    DELETE FROM search_docs WHERE type = 'summary' AND "refId" = NEW.id;
    RETURN NEW;
  END IF;

  v_title := NEW.title;
  v_snippet := left(regexp_replace(coalesce(NEW.body, ''), E'<[^>]+>|[-*#>_\[\]]+|\x60+', ' ', 'g'), 1000);
  v_published_at := NEW."publishedAt";

  INSERT INTO search_docs (id, type, "refId", title, snippet, "publishedAt", "indexedAt", doc_tsv)
  VALUES (
    gen_random_uuid(),
    'summary',
    NEW.id,
    v_title,
    v_snippet,
    v_published_at,
    now(),
    setweight(to_tsvector('simple', coalesce(v_title, '')), 'A')
      || setweight(to_tsvector('simple', coalesce(v_snippet, '')), 'B')
  )
  ON CONFLICT (type, "refId") DO UPDATE SET
    title = EXCLUDED.title,
    snippet = EXCLUDED.snippet,
    "publishedAt" = EXCLUDED."publishedAt",
    "indexedAt" = now(),
    doc_tsv = EXCLUDED.doc_tsv;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_search_docs_summary ON summaries;
CREATE TRIGGER sync_search_docs_summary
  AFTER INSERT OR UPDATE OR DELETE ON summaries
  FOR EACH ROW EXECUTE FUNCTION sync_search_docs_from_summary();

CREATE OR REPLACE FUNCTION sync_search_docs_from_research() RETURNS trigger AS $$
DECLARE
  v_title text;
  v_snippet text;
  v_published_at timestamptz;
  v_doc_type "SearchDocType";
  v_should_index boolean;
BEGIN
  v_should_index := (NEW.status = 'published' AND NEW."publishedAt" IS NOT NULL);

  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_docs
      WHERE "refId" = OLD.id
        AND ((OLD.type = 'research' AND type = 'long_research')
          OR (OLD.type = 'knowledge' AND type = 'knowledge'));
    RETURN OLD;
  END IF;

  IF NOT v_should_index THEN
    DELETE FROM search_docs
      WHERE "refId" = NEW.id
        AND ((NEW.type = 'research' AND type = 'long_research')
          OR (NEW.type = 'knowledge' AND type = 'knowledge'));
    RETURN NEW;
  END IF;

  IF NEW.type = 'research' THEN
    v_doc_type := 'long_research';
  ELSE
    v_doc_type := 'knowledge';
  END IF;

  v_title := NEW.title;
  v_snippet := left(
    regexp_replace(
      coalesce(NEW.background, '') || E'\n' || coalesce(NEW.body, ''),
      E'<[^>]+>|[-*#>_\[\]]+|\x60+', ' ', 'g'
    ),
    1000
  );
  v_published_at := NEW."publishedAt";

  INSERT INTO search_docs (id, type, "refId", title, snippet, "publishedAt", "indexedAt", doc_tsv)
  VALUES (
    gen_random_uuid(),
    v_doc_type,
    NEW.id,
    v_title,
    v_snippet,
    v_published_at,
    now(),
    setweight(to_tsvector('simple', coalesce(v_title, '')), 'A')
      || setweight(to_tsvector('simple', coalesce(v_snippet, '')), 'B')
  )
  ON CONFLICT (type, "refId") DO UPDATE SET
    title = EXCLUDED.title,
    snippet = EXCLUDED.snippet,
    "publishedAt" = EXCLUDED."publishedAt",
    "indexedAt" = now(),
    doc_tsv = EXCLUDED.doc_tsv;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_search_docs_research ON researches;
CREATE TRIGGER sync_search_docs_research
  AFTER INSERT OR UPDATE OR DELETE ON researches
  FOR EACH ROW EXECUTE FUNCTION sync_search_docs_from_research();

-- 2.3 GIN 索引（simple 字典 tsvector）
CREATE INDEX IF NOT EXISTS search_docs_doc_tsv_gin
  ON search_docs USING GIN (doc_tsv);

-- 2.4 回填：历史已发布内容（列名加双引号避免 PG 转小写）
INSERT INTO search_docs (id, type, "refId", title, snippet, "publishedAt", "indexedAt", doc_tsv)
SELECT
  gen_random_uuid(),
  'summary',
  s.id,
  s.title,
  left(regexp_replace(coalesce(s.body, ''), E'<[^>]+>|[-*#>_\[\]]+|\x60+', ' ', 'g'), 1000),
  s."publishedAt",
  now(),
  setweight(to_tsvector('simple', coalesce(s.title, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(s.body, '')), 'B')
FROM summaries s
WHERE s.status = 'published' AND s."publishedAt" IS NOT NULL
ON CONFLICT (type, "refId") DO NOTHING;

INSERT INTO search_docs (id, type, "refId", title, snippet, "publishedAt", "indexedAt", doc_tsv)
SELECT
  gen_random_uuid(),
  CASE WHEN r.type = 'research' THEN 'long_research'::"SearchDocType" ELSE 'knowledge'::"SearchDocType" END,
  r.id,
  r.title,
  left(regexp_replace(coalesce(r.background,'') || E'\n' || coalesce(r.body,''), E'<[^>]+>|[-*#>_\[\]]+|\x60+', ' ', 'g'), 1000),
  r."publishedAt",
  now(),
  setweight(to_tsvector('simple', coalesce(r.title, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(r.body, '')), 'B')
FROM researches r
WHERE r.status = 'published' AND r."publishedAt" IS NOT NULL
ON CONFLICT (type, "refId") DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 3. share_submissions 约束
-- ─────────────────────────────────────────────────────────────

-- 3.1 同一 (submitter, canonicalUrl) 在 pending 状态唯一（防重复提交）
-- failed / approved / rejected 后允许重新提交
CREATE UNIQUE INDEX IF NOT EXISTS share_submissions_active_unique
  ON share_submissions ("submitterId", "canonicalUrl")
  WHERE status = 'pending';

-- 3.2 reviewer 与 submitter 不能同人
ALTER TABLE share_submissions
  ADD CONSTRAINT share_submissions_no_self_review
  CHECK ("reviewerId" IS NULL OR "reviewerId" <> "submitterId");

-- 3.3 终态字段一致性（与 ai_jobs 同模式）
ALTER TABLE share_submissions
  ADD CONSTRAINT share_submissions_terminal_no_lease
  CHECK (
    (status IN ('approved', 'rejected') AND "lockedBy" IS NULL AND "leaseExpiresAt" IS NULL AND "heartbeatAt" IS NULL)
    OR status = 'pending'
  );

-- 3.4 approved 必须有 reviewer + reviewedAt
ALTER TABLE share_submissions
  ADD CONSTRAINT share_submissions_approved_requires_reviewer
  CHECK (
    status <> 'approved' OR ("reviewerId" IS NOT NULL AND "reviewedAt" IS NOT NULL)
  );

COMMIT;
