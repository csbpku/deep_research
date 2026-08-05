-- P1-B: Radar 主动输入 (URL + 文件)
--
-- 目标：让用户能在 /radar 主动添加 URL（GitHub/arxiv/普通文章）或文件
-- (PDF/Markdown/HTML/TXT)，走与管理员触发的雷达同步相同的：
--   安全抓取 → 类型识别 → 内容抽取 → 去重 → 评分 → enrichment → 候选可见
--
-- 与 share_submissions 区别：
--   - share_submissions: 用户把任意 URL 当"分享"提交，需要 Admin 审核才进 radar 候选。
--   - radar_submissions: 已经是 radar 候选输入；URL 命中已知源（github/arxiv）时
--     直接走对应 enrichment；其它情况进 candidate 池等待打分。
--
-- 不复用 content_import_jobs 是因为：
--   - content_import_jobs 产出是 Research（草稿/沉淀）。
--   - radar_submissions 产出是 Summary 候选，沿用现有 radar scoring / enrichment。

CREATE TYPE "RadarSubmissionStatus" AS ENUM (
  'received',         -- 已接收，等待 type detect
  'type_detected',    -- 类型已识别
  'extracting',       -- 正在抓取/抽取
  'scoring',          -- Radar 评分中
  'enriching',        -- enrichment 进行中
  'completed',        -- 已进入候选池 (Summary 已创建)
  'duplicate',        -- 与现有候选 (canonicalUrl) 重复
  'failed'            -- 失败；可由 Admin 触发 retry
);

CREATE TYPE "RadarSubmissionKind" AS ENUM (
  'github_repo', 'github_issue', 'github_pr', 'github_release',
  'arxiv', 'article',
  'pdf', 'markdown', 'html', 'txt'
);

CREATE TABLE "radar_submissions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "submitterId" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "kind" "RadarSubmissionKind" NOT NULL,
  "rawInput" VARCHAR(2048) NOT NULL,                    -- 用户提交的 URL 或文件名
  "canonicalUrl" VARCHAR(2048),                         -- URL 类提交；文件类 null
  "contentSha256" CHAR(64),                             -- 文件类提交；URL 类可空
  "detectedKind" "RadarSubmissionKind",                 -- 类型识别结果（可能等于 kind）
  "status" "RadarSubmissionStatus" NOT NULL DEFAULT 'received',
  "errorCode" VARCHAR(64),
  "errorMessage" VARCHAR(500),
  "summaryId" UUID REFERENCES "summaries"("id") ON DELETE SET NULL,  -- completed 时填
  "attempts" INT NOT NULL DEFAULT 0,
  "lockedBy" VARCHAR(64),
  "leaseExpiresAt" TIMESTAMPTZ(3),
  "heartbeatAt" TIMESTAMPTZ(3),
  "nextRetryAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "completedAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- 同一用户对同一 URL 在非终态唯一（dedup 入口）
CREATE UNIQUE INDEX "radar_submissions_user_url_active_uniq"
  ON "radar_submissions" ("submitterId", "canonicalUrl")
  WHERE "canonicalUrl" IS NOT NULL
    AND "status" NOT IN ('completed', 'duplicate', 'failed');

-- 同一用户对同一 sha256 在非终态唯一（文件 dedup 入口）
CREATE UNIQUE INDEX "radar_submissions_user_sha_active_uniq"
  ON "radar_submissions" ("submitterId", "contentSha256")
  WHERE "contentSha256" IS NOT NULL
    AND "status" NOT IN ('completed', 'duplicate', 'failed');

CREATE INDEX "radar_submissions_status_created_idx"
  ON "radar_submissions" ("status", "createdAt" ASC);

CREATE INDEX "radar_submissions_submitter_idx"
  ON "radar_submissions" ("submitterId", "createdAt" DESC);

-- 状态机合法转换的守门（约束只放主要轴；enrichment worker 跨态走 raw SQL）
ALTER TABLE "radar_submissions"
  ADD CONSTRAINT "radar_submissions_terminal_status_check"
  CHECK (
    ("status" IN ('completed', 'duplicate', 'failed') AND "completedAt" IS NOT NULL)
    OR ("status" NOT IN ('completed', 'duplicate', 'failed') AND "completedAt" IS NULL)
  );
