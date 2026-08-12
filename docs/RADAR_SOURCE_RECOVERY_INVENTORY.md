# 雷达源配置恢复清单

**整理日期**：2026-08-11  
**目的**：记录从当前工作树、Git 历史和运行日志中能够可靠恢复的雷达源配置。  
**原则**：本清单只记录证据，不把 fetcher 能力、历史日志或推测当成曾经存在的数据库配置。  
**状态**：本地未跟踪，不写入数据库，不进入 Git。

## 参考项目证据

主要参考项目：[`duanyytop/agents-radar`](https://github.com/duanyytop/agents-radar)。

它的 README 明确描述了以下来源/采集面：

- GitHub tracked repositories
- Claude Code Skills
- GitHub Trending 与 GitHub Topic Search
- Hacker News
- Product Hunt
- ArXiv
- Hugging Face
- Dev.to
- Lobste.rs
- Anthropic/OpenAI 官方 sitemap 内容

该项目把 tracked repositories 和官方 web 内容作为可配置采集链路。它可以证明“这组来源是重要的设计参考”，但不能证明这些源曾经以相同参数写入本地 `radar_sources`。

## 结论摘要

- 主库初始化时有 4 条 `radar_sources`；根据用户确认的恢复配置，当前主库已扩展为 11 条启用源。
- 这 4 条源均已在 2026-08-11 的真实同步中尝试过。
- Git 历史能确认：最初 seed 有 3 条，后续增加了 WeWe RSS；没有发现更完整的旧 seed 配置。
- 旧日志显示历史上曾出现过 21、23、31 个 source runs，但日志只保存运行数量和结果，没有保存完整的 `radar_sources` 配置。
- 旧备份 [`infra/backups/deep_research-20260728-164909.sql.gz`](../infra/backups/deep_research-20260728-164909.sql.gz) 已审计，业务表为空，不能用于恢复源配置。
- 当前代码支持更多 fetcher，但“代码支持”不等于“之前配置过”。
- `agents-radar` 的来源集合是恢复候选的重要外部证据，但仍不等于本地历史数据库快照。

## 用户确认后的目标配置

2026-08-11 用户确认启用 GitHub Tracked、Reddit 默认集合、Lobsters、Dev.to 默认 tags、Hugging Face、Anthropic 和 OpenAI；Product Hunt 不启用；WeWe 保留但等待重新登录；同步窗口按 24 小时处理。

已写入主库和 seed：

- `radar_sources=11`，全部 `enabled=true`。
- 新增 7 条：GitHub Tracked、Reddit、Lobsters、Dev.to、Hugging Face、Anthropic Official News、OpenAI Official News。
- Hacker News 和 WeWe 的 `maxAgeHours` 已更新为 24。
- GitHub Tracked 使用仓库内 26 个 repo 配置和 7 个 paginated repo。
- Product Hunt 未写入。
- **GitHub token 未写入**。用户在聊天中提供的 token 已视为暴露凭据，必须撤销；当前 AI engine 本地 `GH_TOKEN` 已清空。
- 新增 7 条源尚未完成真实同步；需要新 token 后再对 GitHub Tracked 做同步，WeWe 需要先重新登录。

## A. 可直接恢复/已确认配置

| 源 | `sourceType` | 当前配置证据 | 可信度 | 最近同步证据 |
|---|---|---|---|---|
| GitHub Trending AI/ML | `github` | `type=trending`；5 个 repo：`huggingface/transformers`、`pytorch/pytorch`、`langchain-ai/langchain`、`ollama/ollama`、`openai/openai-cookbook` | 高 | completed，16 条新增 |
| arXiv cs.AI / cs.CL | `arxiv` | `categories=["cs.AI","cs.CL"]`；`max_results=15` | 高 | failed，`UPSTREAM_RATE_LIMITED` |
| Hacker News Frontpage | `rss` | `feedUrl=https://hnrss.org/frontpage`；`maxResults=20` | 高 | partial，8 条新增、2 条候选失败 |
| WeWe RSS 微信公众号 | `rss` | `http://localhost:4001/feeds/all.rss?limit=5`；`maxResults=5`；`maxAgeHours=720`；允许 localhost；关闭 AI filter | 高 | partial，5 条新增；WeWe 账号过期 |

## B. 有明确仓库配置、但尚未注册为数据库源

### GitHub Tracked Repos

证据文件：[`packages/ai-engine/configs/radar_tracked_repos.yml`](../packages/ai-engine/configs/radar_tracked_repos.yml)

- 共 26 个 repo。
- 其中 7 个标记为 `paginated: true`。
- 分为 `cli_repos`、`agents_peers`、`infra_repos`、`foundation_models` 四类。
- 官方注册脚本：[`packages/ai-engine/scripts/seed_tracked_repos.py`](../packages/ai-engine/scripts/seed_tracked_repos.py)。
- 脚本会创建或更新一条 `sourceType=github_tracked` 的数据库源。
- 默认运行窗口为 1 天，每个 repo 最多 20 条活动，包含 issues、PRs、releases。
- 前置条件：GitHub API 可访问；`GH_TOKEN` 可选但会影响限额。
- 可信度：**配置本身高；“以前是否已注册”中**。当前没有旧数据库行可证明它曾被启用。

## C. 代码支持但缺少历史配置证据的候选源

代码入口：[`packages/ai-engine/ai_engine/radar/source_manager.py`](../packages/ai-engine/ai_engine/radar/source_manager.py)

| 源 | 代码默认值/配置 | 启用前置条件 | 可恢复结论 |
|---|---|---|---|
| Reddit | 默认 subreddits：`programming`、`MachineLearning`、`LocalLLaMA`；默认 48 小时；每 subreddit 默认最多 10 条 | Reddit JSON 或 RSS 可访问；必要时调整 UA/限流 | 可以设计新配置；没有证据证明旧库使用过这组默认值 |
| Lobsters | 固定读取 `https://lobste.rs/t/ai.json` 和 `/t/ml.json`；默认 7 天、最多 20 条 | 网络可访问 | 可以设计新配置；无历史数据库证据 |
| Dev.to | 默认 tags：`ai`、`llm`、`machinelearning`、`openai`、`langchain`；最多 30 条 | Dev.to API 可访问 | 可以设计新配置；无历史数据库证据 |
| Product Hunt | 最近约 24–48 小时窗口；最多 20 个 API 结果；支持 AI 关键词/Topic 过滤 | 必须提供 `PRODUCTHUNT_API_TOKEN` 或 source config 的 `api_token` | 不能直接启用，缺 token；无历史数据库证据 |
| 厂商新闻 | 已内置 `anthropic` 和 `openai` 两个 vendor config，使用 sitemap/RSS + HTML 抓取，默认 72 小时窗口 | 外网访问；需要本地状态文件保存 sitemap diff | 可以设计新配置；无历史数据库证据 |
| Hugging Face | source manager 有 `huggingface_models` handler | 需要确认 fetcher 的 source config schema 与运行限额 | 代码存在，但没有旧配置证据，需单独验证 |
| GitHub Topic Search | source manager 有 `github_topic_search` handler | 需要明确 topic/keyword 配置和 GitHub API 限额 | 代码存在，但没有旧配置证据 |

### 参考项目与本项目的映射

| `agents-radar` 采集面 | 本项目对应实现 | 当前结论 |
|---|---|---|
| GitHub tracked repositories | `github_tracked` + [`radar_tracked_repos.yml`](../packages/ai-engine/configs/radar_tracked_repos.yml) | 配置文件可直接审计；是否曾注册需确认 |
| Claude Code Skills | GitHub Trending / tracked repos 可覆盖部分；没有独立 `claude_skills` source type | 不能把它当作独立已恢复源 |
| GitHub Trending | `github` with `type=trending` | 当前已配置并验证 |
| GitHub Topic Search | `github_topic_search` fetcher | 有代码，无历史配置 |
| Hacker News | 当前用 `rss` seed；代码也有官方 Firebase fetcher | 当前已配置的是 RSS 形态，不应擅自改成 API 形态 |
| Product Hunt | `producthunt` fetcher | 缺 token 和历史 row |
| ArXiv | `arxiv` | 当前已配置并验证，但本次受上游限流 |
| Hugging Face | `huggingface_models` fetcher | 有代码，需先确认 config schema |
| Dev.to | `devto` fetcher | 有代码，无历史 row |
| Lobste.rs | `lobsters` fetcher | 有代码，无历史 row |
| Anthropic/OpenAI sitemap | `vendor_news` fetcher；本项目另有 `sitemap_watcher` 但未接统一 handler | 可恢复候选，需先明确是否注册两个 vendor |

### 当前代码边界

- `source_manager.py` 的 `_KNOWN_SOURCE_TYPES` 比 `_HANDLERS` 更宽。
- `sitemap_watch` 被识别为已知类型，但当前没有对应的统一 handler，不能只插入数据库行就认为可运行。
- `wechat` 主要由 RSS/WeWe 路径处理；不能仅凭 source type 名称推断具体 feed。

## D. 历史运行线索，但不能反推出配置

在 `/tmp/deep-research-ai.log` 中观察到：

- 2026-08-06 有 `source_runs=21` 的同步。
- 2026-08-07 有 `source_runs=23`、`source_runs=31` 等同步。
- 这些日志能证明当时运行过更多 source rows 或 source-run 分片，但没有给出完整的 source id/name/config 映射。
- 日志中出现的文章 URL 只能证明某些内容曾被抓取，不能证明它对应一个长期启用的 `radar_sources` 配置。

## E. 不应自动恢复的内容

以下内容目前没有足够证据，不能直接写回主库：

- 旧数据库中每条额外源的名称和展示顺序。
- Reddit subreddit 列表是否就是代码默认值。
- Product Hunt token。
- 厂商新闻是否启用 Anthropic、OpenAI 或其他 vendor。
- 任何本地/私有 RSS、微信公众号源地址。
- 旧 source 的 enabled 状态、refresh frequency 和 operator overrides。

## F. 建议的恢复顺序

1. 直接保留 A 类 4 个源，作为当前可验证基线。
2. 如需扩大覆盖，先注册 B 类 `github_tracked`，因为配置文件和 seed 脚本完整、可审计。
3. 再逐个评估 C 类源，每个源先在隔离库做一次 fetch smoke，再写入主库。
4. 每次新增源都记录：名称、source type、完整 config、凭据来源、预期频率、首次同步结果和失败原因。
5. 不把“历史 source runs 数量”当成旧源清单，也不从文章日志反推配置。
