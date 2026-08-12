-- Seed: 真实雷达数据源（不含 demo 数据）
-- Run: psql -h localhost -U postgres -d deep_research -f apps/web/prisma/seed.sql
-- 数据由 AI Engine 同步拉取，本文件只注册数据源

BEGIN;

-- 只插入数据源，数据由同步跑出来
INSERT INTO radar_sources (id, name, "sourceType", config, enabled, "updatedAt")
VALUES
  -- GitHub 热门 AI 仓库（无需 token 即可读，但有 token 限额更高）
  -- Expanded repo list 5→15 to capture the long-tail of active AI tooling.
  ('a0000000-0000-0000-0000-000000000001', 'GitHub Trending AI/ML', 'github',
   '{"type": "trending", "orgs": [], "repos": ["huggingface/transformers", "pytorch/pytorch", "langchain-ai/langchain", "ollama/ollama", "openai/openai-cookbook", "openai/codex", "anthropics/claude-code", "google-gemini/gemini-cli", "ggerganov/llama.cpp", "huggingface/diffusers", "huggingface/transformers", "run-llama/llama_index", "crewAIInc/crewAI", "All-Hands-AI/OpenHands", "vllm-project/vllm"]}'::jsonb,
   true, now()),
  -- Arxiv cs.AI + cs.CL + cs.LG — full daily AI set, 3 categories covers
  -- Mon submission spikes; 30 papers per run keeps arxiv API latency <5s.
  -- lookbackHours=168 keeps a 7-day backlog.
  ('a0000000-0000-0000-0000-000000000002', 'Arxiv cs.AI / cs.CL / cs.LG', 'arxiv',
   '{"categories": ["cs.AI", "cs.CL", "cs.LG"], "maxResults": 30, "maxCandidates": 30, "lookbackHours": 168}'::jsonb,
   true, now()),
  -- Hacker News via hnrss（纯公开，无需 key）
  ('a0000000-0000-0000-0000-000000000003', 'Hacker News Frontpage', 'rss',
   '{"feedUrl": "https://hnrss.org/frontpage", "maxResults": 20, "maxAgeHours": 24}'::jsonb,
   true, now()),
  -- WeWe RSS 微信公众号源（需外部 WeWe RSS 服务监听 localhost:4001）
  ('a0000000-0000-0000-0000-000000000004', 'WeWe RSS 微信公众号', 'rss',
   '{"feedUrl": "http://localhost:4001/feeds/all.rss?limit=5", "localPort": 4001, "maxResults": 5, "maxAgeHours": 24, "allowLocalhost": true, "applyAiFilter": false}'::jsonb,
   true, now()),
  -- GitHub Tracked：来自 configs/radar_tracked_repos.yml 的 42 个仓库（PR2 扩 26→42，新增 deepseek/mistral/llama.cpp/unsloth/diffusers/peft 等）
  ('a0000000-0000-0000-0000-000000000005', 'GitHub Tracked Repos (curated)', 'github_tracked',
   '{"repos":["anthropics/claude-code","openai/codex","google-gemini/gemini-cli","Aider-AI/aider","All-Hands-AI/OpenHands","cline/cline","block/goose","continuedev/continue","langchain-ai/langgraph","The-Pocket/PocketFlow","different-ai/openwork","microsoft/autogen","crewAIInc/crewAI","AI-Agent-Hackathon/agent-protocol","vllm-project/vllm","BerriAI/litellm","ollama/ollama","huggingface/transformers","sgl-project/sglang","langchain-ai/langchain","run-llama/llama_index","comfyanonymous/ComfyUI","openai/gpt-oss","meta-llama/llama3","moonshotai/Kimi-K3","QwenLM/Qwen3","deepseek-ai/DeepSeek-V3","mistralai/mistral-inference","anthropics/anthropic-sdk-python","huggingface/smol-course","unslothai/unsloth","ggerganov/llama.cpp","huggingface/diffusers","huggingface/peft","huggingface/trl","meta-llama/llama-cookbook","openvinotoolkit/openvino","microsoft/onnxruntime"],"lookback_days":3,"max_items_per_repo":15,"include_issues":true,"include_prs":true,"include_releases":true,"paginated_repos":["vllm-project/vllm","BerriAI/litellm","ollama/ollama","huggingface/transformers","sgl-project/sglang","langchain-ai/langchain","run-llama/llama_index","ggerganov/llama.cpp","microsoft/onnxruntime","openvinotoolkit/openvino"]}'::jsonb,
   true, now()),
  -- Reddit：P2.13 扩展 subreddits 至 6 个，覆盖 singularity / StableDiffusion / ChatGPT 等 AI 周圈。
  ('a0000000-0000-0000-0000-000000000006', 'Reddit AI Communities', 'reddit',
   '{"subreddits":["programming","MachineLearning","LocalLLaMA","singularity","ChatGPT","StableDiffusion"],"max_per_subreddit":10,"max_age_hours":24}'::jsonb,
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
  -- P2.15: bumped maxResults 20 → 30 to capture the full daily set (~25-40).
  ('a0000000-0000-0000-0000-000000000012', 'Hugging Face Daily Papers', 'huggingface_papers',
   '{"maxResults":30,"number_of_papers":80,"maxAgeHours":168,"minKeywordOverlap":0}'::jsonb,
   true, now()),
  -- PR3: OpenReview accepted papers — covers the venues that don't fully appear
  -- on arXiv (NeurIPS / ICML / ICLR). Config drives which venues + search term.
  -- added 2025 venues for the active submission cycle.
  ('a0000000-0000-0000-0000-000000000013', 'OpenReview Accepted Papers', 'openreview',
   '{"venues":["NeurIPS.cc/2025/Conference","NeurIPS.cc/2024/Conference","ICLR.cc/2025/Conference","ICML.cc/2024/Conference"],"query":"agent","maxResults":40,"maxAgeDays":30,"limitPerVenue":20}'::jsonb,
   true, now()),
  -- PR4: HN Algolia — keyword + time-bounded AI story search coexists with the
  -- existing Hacker News front-page RSS source so the admin sees two radar
  -- rows instead of one. Query uses plain space-separated terms (Algolia
  -- implicit OR); parenthetical OR with mixed terms ranks poorly so we kept
  -- the query short and high-signal.
  ('a0000000-0000-0000-0000-000000000014', 'Hacker News AI Stories (Algolia)', 'hn_algolia',
   '{"query":"AI OR LLM OR agent OR chatgpt OR claude OR gemini","maxResults":30,"maxAgeHours":48,"minPoints":2,"minComments":0,"tags":"story"}'::jsonb,
   true, now()),
  -- PR5: vendor_news YAML-ised and extended from 2 → 6 vendors. The vendor key
  -- in config resolves to an entry in packages/ai-engine/configs/vendor_news.yml.
  ('a0000000-0000-0000-0000-000000000015', 'Google DeepMind Blog', 'vendor_news',
   '{"vendor":"google_deepmind","max_age_hours":72}'::jsonb,
   true, now()),
  ('a0000000-0000-0000-0000-000000000016', 'xAI News', 'vendor_news',
   '{"vendor":"xai","max_age_hours":96}'::jsonb,
   true, now()),
  ('a0000000-0000-0000-0000-000000000017', 'xAI News', 'vendor_news',
   '{"vendor":"xai","max_age_hours":96}'::jsonb,
   true, now()),
  ('a0000000-0000-0000-0000-000000000018', 'Hugging Face Blog', 'vendor_news',
   '{"vendor":"huggingface_blog","max_age_hours":96}'::jsonb,
   true, now()),
  -- P2.14 中文 AI 信源 RSS — 机器之心、量子位都有公开 RSS feed。
  ('a0000000-0000-0000-0000-000000000019', '机器之心 (Jiqizhixin)', 'rss',
   '{"feedUrl":"https://www.jiqizhixin.com/rss","maxResults":20,"maxAgeHours":72,"applyAiFilter":false}'::jsonb,
   true, now()),
  ('a0000000-0000-0000-0000-000000000020', '量子位 (QbitAI)', 'rss',
   '{"feedUrl":"https://www.qbitai.com/feed","maxResults":20,"maxAgeHours":72,"applyAiFilter":false}'::jsonb,
   true, now()),
  -- P1.11 API Changelog — engineer-facing release notes for OpenAI + Anthropic.
  -- The fetcher uses configured sources + a title extraction pattern, dedupes
  -- via a statefile, and surfaces entries as RadarCandidates so they show up
  -- alongside vendor_news but in a distinct timeline.
  ('a0000000-0000-0000-0000-000000000022', 'OpenAI Changelog', 'vendor_changelog',
   '{"vendor":"openai","sources":["https://platform.openai.com/docs/changelog"],"title_pattern":"<h2[^>]*>(.*?)</h2>","max_entries":30}'::jsonb,
   true, now()),
  ('a0000000-0000-0000-0000-000000000023', 'Anthropic Release Notes', 'vendor_changelog',
   '{"vendor":"anthropic","sources":["https://docs.anthropic.com/en/release-notes/"],"title_pattern":"<h[1-3][^>]*>(.*?)</h[1-3]>","allow_path_regex":"/release-notes/","max_entries":30}'::jsonb,
   true, now()),
  -- P1.9 Product Hunt — fetcher exists, requires PRODUCTHUNT_API_TOKEN env.
  -- Without the env var the source will surface as a failed row in
  -- radar_sync_diagnostics; the seed inserts the row so admins can flip the
  -- env and have it appear in /radar without a separate migration.
  ('a0000000-0000-0000-0000-000000000024', 'Product Hunt AI Tools', 'producthunt',
   '{"fetch_count":60,"max_results":20,"max_age_hours":48}'::jsonb,
   true, now())
ON CONFLICT DO NOTHING;

COMMIT;

SELECT 'radar_sources' AS tbl, count(*) AS cnt FROM radar_sources;
