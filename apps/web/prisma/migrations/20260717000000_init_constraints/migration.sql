-- Migration: schema.prisma 不能直接表达的约束（CHECK / 全文搜索 / 自定义触发器）
-- 与 schema.prisma 一起落地；Week 0 schema freeze 一次性随仓库 commit。
-- engineer A/B 不直接改；修改走 [db] PR。

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. comments 双 FK 恰好一非空（架构 §十四）
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE "comments"
    ADD CONSTRAINT comments_one_target_not_null
    CHECK (
        (("researchId" IS NOT NULL)::int + ("summaryId" IS NOT NULL)::int) = 1
    );

-- ─────────────────────────────────────────────────────────────────────
-- 2. 全文搜索（架构 §86 zhparser + tsvector/GIN，Week 4 落地）
--  这一步 Week 0 仅建 zhparser 扩展和列；
--  触发器 + 索引在 apps/web/prisma/migrations/ 后续 migration 加，
--  因为 zhparser 需要 DBA 手动建（DAY0 不是 schema freeze 范围）。
-- ─────────────────────────────────────────────────────────────────────
-- 见 20260718000000_full_text_search.sql（推迟到 Week 4 前一周加，
-- 防止现在 lock schema freeze 阶段引入 DBA 流程）

-- ─────────────────────────────────────────────────────────────────────
-- 3. researches tags 数组 GIN（架构 §十一）
-- ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS researches_tags_gin
    ON "researches" USING GIN (tags);

-- 复合索引 brainstorm A6 中追加项（架构 §十一 GIN 已采纳，复合 index 5 行 SQL 顺手做）
CREATE INDEX IF NOT EXISTS summaries_source_created_idx
    ON "summaries" (source, "createdAt" DESC);
CREATE INDEX IF NOT EXISTS researches_type_published_idx
    ON "researches" (type, "publishedAt" DESC);

-- ─────────────────────────────────────────────────────────────────────
-- 4. updated_at 自动更新触发器（架构 §五 默认 now()）
--  Prisma 不直接生成；这里手写
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW."updatedAt" = now();
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT unnest(ARRAY[
            'users', 'summaries', 'researches',
            'research_sources', 'ai_research_jobs',
            'ai_research_sources', 'comments',
            'comment_stars', 'content_import_jobs'
        ])
    LOOP
        EXECUTE format(
            'CREATE TRIGGER %1$I_touch_updated_at
             BEFORE UPDATE ON %1$I
             FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
            t
        );
    END LOOP;
END $$;

COMMIT;
