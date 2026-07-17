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
-- 3.5  partial index（Prisma 5.x schema.prisma 不支持 where 限定，
--       架构 §十三 §3 / §四点七 必须有 partial，否则 worker 抢锁全表扫描）
-- ─────────────────────────────────────────────────────────────────────

-- AI 调研抢锁队列：只对 status='queued' 的一部分建复合索引（与小 cardinality）
CREATE INDEX IF NOT EXISTS ai_jobs_queue_partial
    ON "ai_research_jobs" ("createdAt" ASC)
    WHERE status = 'queued';

-- AI 调研 worker 抢锁与 reaper 查询（status='running' 且 lease 未过期）
CREATE INDEX IF NOT EXISTS ai_jobs_running_lease_partial
    ON "ai_research_jobs" ("leaseExpiresAt" ASC)
    WHERE status = 'running';

-- 候选摘要（每日摘要未精选前的）查询；summary_date 倒序
CREATE INDEX IF NOT EXISTS summaries_candidate_partial
    ON "summaries" ("createdAt" DESC)
    WHERE status = 'candidate';

-- worker 队列候选（content import）
CREATE INDEX IF NOT EXISTS content_import_jobs_active_partial
    ON "content_import_jobs" ("createdAt" ASC)
    WHERE status IN ('queued', 'running');

-- import 任务"已有导入"：同 user 同 SHA-256 已 succeeded 时拒绝重复创建
CREATE UNIQUE INDEX IF NOT EXISTS content_import_user_hash_partial_uniq
    ON "content_import_jobs" ("requesterId", "contentSha256")
    WHERE "sourceKind" = 'file'
      AND "contentSha256" IS NOT NULL
      AND status = 'succeeded';

-- researches 中 aiAssisted=true 的子集索引（架构 §十二点五 §3）
CREATE INDEX IF NOT EXISTS researches_ai_assisted_partial
    ON "researches" ("id")
    WHERE "aiAssisted" = true;

-- AI 调研 idempotency：单用户 unique（idempotencyKey 非空时）
CREATE UNIQUE INDEX IF NOT EXISTS ai_jobs_idempotency_partial_uniq
    ON "ai_research_jobs" ("requesterId", "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;

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
