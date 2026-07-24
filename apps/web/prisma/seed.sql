-- Seed: 真实雷达数据源（不含 demo 数据）
-- Run: psql -h localhost -U postgres -d deep_research -f apps/web/prisma/seed.sql
-- 数据由 AI Engine 同步拉取，本文件只注册数据源

BEGIN;

-- 只插入数据源，数据由同步跑出来
INSERT INTO radar_sources (id, name, "sourceType", config, enabled, "updatedAt")
VALUES
  -- GitHub 热门 AI 仓库（无需 token 即可读，但有 token 限额更高）
  ('a0000000-0000-0000-0000-000000000001', 'GitHub Trending AI/ML', 'github',
   '{"type": "trending", "orgs": [], "repos": ["huggingface/transformers", "pytorch/pytorch", "langchain-ai/langchain", "ollama/ollama", "openai/openai-cookbook"]}'::jsonb,
   true, now()),
  -- Arxiv cs.AI + cs.CL（纯公开 API，无需 key）
  ('a0000000-0000-0000-0000-000000000002', 'Arxiv cs.AI / cs.CL', 'arxiv',
   '{"categories": ["cs.AI", "cs.CL"], "max_results": 15}'::jsonb,
   true, now()),
  -- Hacker News via hnrss（纯公开，无需 key）
  ('a0000000-0000-0000-0000-000000000003', 'Hacker News Frontpage', 'rss',
   '{"feedUrl": "https://hnrss.org/frontpage", "maxResults": 20}'::jsonb,
   true, now())
ON CONFLICT DO NOTHING;

COMMIT;

SELECT 'radar_sources' AS tbl, count(*) AS cnt FROM radar_sources;
