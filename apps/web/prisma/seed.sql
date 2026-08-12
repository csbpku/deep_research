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
   '{"categories": ["cs.AI", "cs.CL"], "maxResults": 15}'::jsonb,
   true, now()),
  -- Hacker News via hnrss（纯公开，无需 key）
  ('a0000000-0000-0000-0000-000000000003', 'Hacker News Frontpage', 'rss',
   '{"feedUrl": "https://hnrss.org/frontpage", "maxResults": 20, "maxAgeHours": 24}'::jsonb,
   true, now()),
  -- WeWe RSS 微信公众号源（需外部 WeWe RSS 服务监听 localhost:4001）
  ('a0000000-0000-0000-0000-000000000004', 'WeWe RSS 微信公众号', 'rss',
   '{"feedUrl": "http://localhost:4001/feeds/all.rss?limit=5", "localPort": 4001, "maxResults": 5, "maxAgeHours": 24, "allowLocalhost": true, "applyAiFilter": false}'::jsonb,
   true, now()),
  -- GitHub Tracked：来自 configs/radar_tracked_repos.yml 的 26 个仓库
  ('a0000000-0000-0000-0000-000000000005', 'GitHub Tracked Repos (curated)', 'github_tracked',
   '{"repos":["anthropics/claude-code","openai/codex","google-gemini/gemini-cli","Aider-AI/aider","All-Hands-AI/OpenHands","cline/cline","block/goose","continuedev/continue","langchain-ai/langgraph","The-Pocket/PocketFlow","different-ai/openwork","microsoft/autogen","crewAIInc/crewAI","AI-Agent-Hackathon/agent-protocol","vllm-project/vllm","BerriAI/litellm","ollama/ollama","huggingface/transformers","sgl-project/sglang","langchain-ai/langchain","run-llama/llama_index","comfyanonymous/ComfyUI","openai/gpt-oss","meta-llama/llama3","moonshotai/Kimi-K3","QwenLM/Qwen3"],"lookback_days":1,"max_items_per_repo":20,"include_issues":true,"include_prs":true,"include_releases":true,"paginated_repos":["vllm-project/vllm","BerriAI/litellm","ollama/ollama","huggingface/transformers","sgl-project/sglang","langchain-ai/langchain","run-llama/llama_index"]}'::jsonb,
   true, now()),
  -- Reddit：采用 fetcher 默认 subreddit 集合，24 小时窗口
  ('a0000000-0000-0000-0000-000000000006', 'Reddit AI Communities', 'reddit',
   '{"subreddits":["programming","MachineLearning","LocalLLaMA"],"max_per_subreddit":10,"max_age_hours":24}'::jsonb,
   true, now()),
  -- Lobste.rs：AI/ML 标签页，24 小时窗口
  ('a0000000-0000-0000-0000-000000000007', 'Lobste.rs AI/ML', 'lobsters',
   '{"max_results":20,"max_age_hours":24}'::jsonb,
   true, now()),
  -- Dev.to：采用 fetcher 默认 AI tags，24 小时窗口
  ('a0000000-0000-0000-0000-000000000008', 'Dev.to AI', 'devto',
   '{"tags":["ai","llm","machinelearning","openai","langchain"],"max_results":30,"max_age_hours":24}'::jsonb,
   true, now()),
  -- Hugging Face：按过去 7 天 likes 排序
  ('a0000000-0000-0000-0000-000000000009', 'Hugging Face Trending Models', 'huggingface_models',
   '{"sort":"likes7d","max_results":30}'::jsonb,
   true, now()),
  -- 官方厂商新闻：sitemap/RSS 增量抓取，24 小时 lookback
  ('a0000000-0000-0000-0000-000000000010', 'Anthropic Official News', 'vendor_news',
   '{"vendor":"anthropic","max_age_hours":24}'::jsonb,
   true, now()),
  ('a0000000-0000-0000-0000-000000000011', 'OpenAI Official News', 'vendor_news',
   '{"vendor":"openai","max_age_hours":24}'::jsonb,
   true, now()),
  -- PR2: Hugging Face Daily Papers — the no-miss AI research signal used by every
  -- comparable newsletter (Latent Space / The Batch / AlphaSignal). Lag of ~24h
  -- is fine for a daily cron; arxiv-mcp enrichment still runs downstream.
  ('a0000000-0000-0000-0000-000000000012', 'Hugging Face Daily Papers', 'huggingface_papers',
   '{"maxResults":20,"number_of_papers":50,"maxAgeHours":96,"minKeywordOverlap":0}'::jsonb,
   true, now()),
  -- PR3: OpenReview accepted papers — covers the venues that don't fully appear
  -- on arXiv (NeurIPS / ICML / ICLR). Config drives which venues + search term.
  ('a0000000-0000-0000-0000-000000000013', 'OpenReview Accepted Papers', 'openreview',
   '{"venues":["NeurIPS.cc/2024/Conference","ICLR.cc/2025/Conference","ICML.cc/2024/Conference"],"query":"agent","maxResults":30,"maxAgeDays":14,"limitPerVenue":30}'::jsonb,
   true, now())
ON CONFLICT DO NOTHING;

COMMIT;

SELECT 'radar_sources' AS tbl, count(*) AS cnt FROM radar_sources;
