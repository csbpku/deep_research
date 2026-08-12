-- Seed: 真实雷达数据源（不含 demo 数据）。
-- Run: psql -h localhost -U postgres -d deep_research -f apps/web/prisma/seed.sql
--
-- 生成时间: 2026-08-12
-- 当前源数量: 22
-- 注意：本文件使用 ON CONFLICT (id) DO UPDATE，因此可安全重复运行，
-- 会在已有 ID 存在时更新 name + config + sourceType，而不是跳过。
-- 数据库是运行时的权威配置源，seed.sql 仅在初始部署或重置后执行。

BEGIN;

INSERT INTO radar_sources (id, name, "sourceType", config, enabled, "updatedAt")
VALUES
  -- 1 — GitHub Trending AI/ML (15 repos, HTML scrape)
  ('a0000000-0000-0000-0000-000000000001', 'GitHub Trending AI/ML', 'github',
   '{"orgs": [], "type": "trending", "repos": ["huggingface/transformers", "pytorch/pytorch", "langchain-ai/langchain", "ollama/ollama", "openai/openai-cookbook", "openai/codex", "anthropics/claude-code", "google-gemini/gemini-cli", "ggerganov/llama.cpp", "huggingface/diffusers", "run-llama/llama_index", "crewAIInc/crewAI", "All-Hands-AI/OpenHands", "vllm-project/vllm", "sgl-project/sglang"]}'::jsonb,
   true, now()),

  -- 2 — Arxiv cs.AI / cs.CL / cs.LG (30 papers, 168h lookback)
  ('a0000000-0000-0000-0000-000000000002', 'Arxiv cs.AI / cs.CL / cs.LG', 'arxiv',
   '{"categories": ["cs.AI", "cs.CL", "cs.LG"], "maxResults": 30, "lookbackHours": 168, "maxCandidates": 30}'::jsonb,
   true, now()),

  -- 3 — Hacker News Frontpage (hnrss RSS, 20 items, 24h window)
  ('a0000000-0000-0000-0000-000000000003', 'Hacker News Frontpage', 'rss',
   '{"feedUrl": "https://hnrss.org/frontpage", "maxResults": 20, "maxAgeHours": 24}'::jsonb,
   true, now()),

  -- 4 — WeWe RSS 微信公众号 (needs localhost:4001 WeWe service)
  ('a0000000-0000-0000-0000-000000000004', 'WeWe RSS 微信公众号', 'rss',
   '{"feedUrl": "http://localhost:4001/feeds/all.rss?limit=5", "localPort": 4001, "maxResults": 5, "maxAgeHours": 24, "applyAiFilter": false, "allowLocalhost": true}'::jsonb,
   true, now()),

  -- 5 — GitHub Tracked Repos (38 repos, 3-day lookback, issues/PRs/releases)
  ('a0000000-0000-0000-0000-000000000005', 'GitHub Tracked Repos (curated)', 'github_tracked',
   '{"repos": ["anthropics/claude-code", "openai/codex", "google-gemini/gemini-cli", "Aider-AI/aider", "All-Hands-AI/OpenHands", "cline/cline", "block/goose", "continuedev/continue", "langchain-ai/langgraph", "The-Pocket/PocketFlow", "different-ai/openwork", "microsoft/autogen", "crewAIInc/crewAI", "AI-Agent-Hackathon/agent-protocol", "vllm-project/vllm", "BerriAI/litellm", "ollama/ollama", "huggingface/transformers", "sgl-project/sglang", "langchain-ai/langchain", "run-llama/llama_index", "comfyanonymous/ComfyUI", "openai/gpt-oss", "meta-llama/llama3", "moonshotai/Kimi-K3", "QwenLM/Qwen3", "deepseek-ai/DeepSeek-V3", "mistralai/mistral-inference", "anthropics/anthropic-sdk-python", "huggingface/smol-course", "unslothai/unsloth", "ggerganov/llama.cpp", "huggingface/diffusers", "huggingface/peft", "huggingface/trl", "meta-llama/llama-cookbook", "openvinotoolkit/openvino", "microsoft/onnxruntime"], "include_prs": true, "lookback_days": 3, "include_issues": true, "paginated_repos": ["vllm-project/vllm", "BerriAI/litellm", "ollama/ollama", "huggingface/transformers", "sgl-project/sglang", "langchain-ai/langchain", "run-llama/llama_index", "ggerganov/llama.cpp", "microsoft/onnxruntime", "openvinotoolkit/openvino"], "include_releases": true, "max_items_per_repo": 15}'::jsonb,
   true, now()),

  -- 6 — Reddit AI Communities (original 3 subs)
  ('a0000000-0000-0000-0000-000000000006', 'Reddit AI Communities', 'reddit',
   '{"subreddits": ["programming", "MachineLearning", "LocalLLaMA"], "max_age_hours": 24, "max_per_subreddit": 10}'::jsonb,
   true, now()),

  -- 7 — Lobste.rs AI/ML (t/ai + t/ml tags)
  ('a0000000-0000-0000-0000-000000000007', 'Lobste.rs AI/ML', 'lobsters',
   '{"max_results": 20, "max_age_hours": 24}'::jsonb,
   true, now()),

  -- 8 — Dev.to AI (5 tags, 24h window, AI-keyword filter)
  ('a0000000-0000-0000-0000-000000000008', 'Dev.to AI', 'devto',
   '{"tags": ["ai", "llm", "machinelearning", "openai", "langchain"], "max_results": 30, "max_age_hours": 24}'::jsonb,
   true, now()),

  -- 9 — Hugging Face Trending Models (likes7d sort, 30 max)
  ('a0000000-0000-0000-0000-000000000009', 'Hugging Face Trending Models', 'huggingface_models',
   '{"sort": "likes7d", "max_results": 30}'::jsonb,
   true, now()),

  -- 10 — Anthropic Official News (sitemap, 72h window, statefile-deduped)
  ('a0000000-0000-0000-0000-000000000010', 'Anthropic Official News', 'vendor_news',
   '{"vendor": "anthropic", "max_age_hours": 72}'::jsonb,
   true, now()),

  -- 11 — OpenAI Official News (RSS, 72h window, statefile-deduped)
  ('a0000000-0000-0000-0000-000000000011', 'OpenAI Official News', 'vendor_news',
   '{"vendor": "openai", "max_age_hours": 72}'::jsonb,
   true, now()),

  -- 12 — Hugging Face Daily Papers (20 max, 96h lookback)
  ('a0000000-0000-0000-0000-000000000012', 'Hugging Face Daily Papers', 'huggingface_papers',
   '{"maxResults": 20, "maxAgeHours": 96, "number_of_papers": 50, "minKeywordOverlap": 0}'::jsonb,
   true, now()),

  -- 13 — OpenReview accepted papers (4 venues, 400d window, term=agent)
  ('a0000000-0000-0000-0000-000000000013', 'OpenReview Accepted Papers', 'openreview',
   '{"query": "agent", "venues": ["NeurIPS.cc/2025/Conference", "NeurIPS.cc/2024/Conference", "ICLR.cc/2025/Conference", "ICML.cc/2024/Conference"], "maxAgeDays": 400, "maxResults": 40, "limitPerVenue": 20}'::jsonb,
   true, now()),

  -- 14 — Hacker News AI Stories (Algolia, keyword search, 48h window, minPoints=2)
  ('a0000000-0000-0000-0000-000000000014', 'Hacker News AI Stories (Algolia)', 'hn_algolia',
   '{"query": "AI OR LLM OR agent OR chatgpt OR claude OR gemini", "maxResults": 30, "maxAgeHours": 48, "minPoints": 2, "minComments": 0, "tags": "story"}'::jsonb,
   true, now()),

  -- 15 — Google DeepMind Blog (RSS, 72h window)
  ('a0000000-0000-0000-0000-000000000015', 'Google DeepMind Blog', 'vendor_news',
   '{"vendor": "google_deepmind", "max_age_hours": 72}'::jsonb,
   true, now()),

  -- 16 — xAI News (sitemap, 96h window)
  ('a0000000-0000-0000-0000-000000000016', 'xAI News', 'vendor_news',
   '{"vendor": "xai", "max_age_hours": 96}'::jsonb,
   true, now()),

  -- 17 — Hugging Face Blog (RSS, 96h window)
  ('a0000000-0000-0000-0000-000000000017', 'Hugging Face Blog', 'vendor_news',
   '{"vendor": "huggingface_blog", "max_age_hours": 96}'::jsonb,
   true, now()),

  -- 18 — Reddit AI Communities expanded (6 subs)
  ('a0000000-0000-0000-0000-000000000018', 'Reddit AI Communities (expanded)', 'reddit',
   '{"subreddits": ["programming", "MachineLearning", "LocalLLaMA", "singularity", "ChatGPT", "StableDiffusion"], "max_age_hours": 24, "max_per_subreddit": 10}'::jsonb,
   true, now()),

  -- 19 — OpenAI Changelog (anchor-extractor + legacy title_pattern fallback)
  ('a0000000-0000-0000-0000-000000000019', 'OpenAI Changelog', 'vendor_changelog',
   '{"vendor": "openai", "sources": ["https://platform.openai.com/docs/changelog"], "max_entries": 30, "title_pattern": "<h2[^>]*>(.*?)</h2>"}'::jsonb,
   true, now()),

  -- 20 — Anthropic Release Notes (anchor-extractor only, no title_pattern)
  ('a0000000-0000-0000-0000-000000000020', 'Anthropic Release Notes', 'vendor_changelog',
   '{"vendor": "anthropic", "sources": ["https://docs.anthropic.com/en/release-notes/"], "max_entries": 30, "allow_path_regex": "/release-notes/"}'::jsonb,
   true, now()),

  -- 21 — Product Hunt AI Tools (GraphQL, needs PRODUCTHUNT_API_TOKEN)
  ('a0000000-0000-0000-0000-000000000021', 'Product Hunt AI Tools', 'producthunt',
   '{"fetch_count": 60, "max_results": 20, "max_age_hours": 48}'::jsonb,
   true, now()),

  -- 22 — 量子位 (QbitAI) RSS (72h window, no AI filter)
  ('a0000000-0000-0000-0000-000000000022', '量子位 (QbitAI)', 'rss',
   '{"feedUrl": "https://www.qbitai.com/feed", "maxResults": 20, "maxAgeHours": 72, "applyAiFilter": false}'::jsonb,
   true, now())

ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  "sourceType" = EXCLUDED."sourceType",
  config = EXCLUDED.config,
  "updatedAt" = now();

COMMIT;

SELECT 'radar_sources' AS tbl, count(*) AS cnt FROM radar_sources;
