# packages/ai-engine — AI 与后台任务服务

FastAPI/Python 服务，负责 AI 调研适配、异步任务、技术雷达抓取与解读、导入/分享 worker、SSRF-safe URL fetch，以及摘要上下文 AI 讨论。

## 当前能力（2026-08-20）

- `adapters/`：统一 `ResearchEngineAdapter` 协议，当前运行时使用
  `gpt_researcher`，`fake` 仅用于测试/CI 或无凭证的 UI walkthrough。
- `job_runner/`：内存/数据库 store、幂等 replay、日配额、lease、reaper 和任务执行。
- `radar/`：GitHub、arXiv、RSS source 管理、抓取、同步与解释流水线。
- `fetcher/`：SSRF-safe URL fetch 与 source URL 处理（gpt-researcher 内部使用 Tavily/DuckDuckGo 作为 retriever；该配置来自 `RETRIEVER` env，不再走我们 fetcher 目录）。
- `server/`：health、AI job、radar sync、share submission 和 chat endpoints。
- 顶层 worker：文件导入与分享提交处理。

`gpt-researcher` 是当前运行时主适配（ADR 0004 复评通过）；`fake` 是测试/CI fallback。Claude 适配（`adapters/claude.py`）已从 `build_adapter` 工厂移除，历史 spike 报告保留在 `reports/`，引擎选型见 `docs/decisions/0004-ai-engine-selection.md`。默认 retriever 通过 `RETRIEVER` env 切换（`tavily` / `duckduckgo` / `google` 等，由 gpt-researcher 内部负责；本仓库不直接调用 Tavily）。只有 `RETRIEVER=tavily` 时才需要 `TAVILY_API_KEY`。

### LLM 配置真相源

- 模型槽位统一使用 `<provider>:<model>`：`SMART_LLM`（重型研究）、
  `STRATEGIC_LLM`（策略步骤）、`FAST_LLM`（快速子查询）和 `BRIEF_LLM`
  （摘要、评分、聊天）。未设置时，重型默认
  `anthropic:claude-haiku-4-5`；轻型调用按
  `FAST_LLM → BRIEF_LLM → SMART_LLM` 回退。
- `scripts/setup.sh` 会按兼容端点的 `/models` 返回值选择模型，接口不可发现时
  允许手动输入，并把所选模型写入四个槽位。`--quick`/fake 模式会写入
  `anthropic:deepseek-v4-flash`，但不会发起真实 LLM 调用。
- `ANTHROPIC_*` / `OPENAI_*` 提供对应 provider 的凭证和 base URL；重型研究
  优先使用对应的 `*_HEAVY` 配置，未设置时回退到普通配置。`LLM_FALLBACK_LLM`
  是额度/限流时的共享备用模型。
- 本地部署可使用 cc-switch（Anthropic 兼容）、ais-switch 或 vibeproxy
  （OpenAI 兼容）；模型名必须来自该端点实际支持的 `/models`，不要直接照抄
  `.env.example` 的示例值。

## 目录

```text
packages/ai-engine/
├── ai_engine/
│   ├── adapters/           # gpt-researcher / fake adapter
│   ├── contracts/          # packages/shared 状态和错误码的 Python 镜像
│   ├── fetcher/            # SSRF-safe fetch、Tavily、source URLs
│   ├── ingestion/          # 摘要摄取流水线
│   ├── job_runner/         # stores、runner、任务模型
│   ├── radar/              # sources、fetchers、pipeline、sync
│   └── server/             # FastAPI app、chat、share
├── tests/
├── tools/                  # spike 与运维工具
└── reports/                # 历史 spike 输出
```

## 本地开发

```bash
cd packages/ai-engine
uv sync
uv run uvicorn ai_engine.server.app:app --port 4000
```

从仓库根目录执行 `pnpm dev:ai` 等价，并把 uv cache 放到 `/tmp`。

## 主要端点

- `GET /health`、`GET /healthz`
- `POST /api/ai/jobs`、`GET /api/ai/jobs/{id}`、`POST /api/ai/jobs/{id}/cancel`
- `POST /api/ai/radar/sync`
- `POST /api/ai/shares/{share_id}/submit`
- `POST /api/chat/sessions`、`GET /api/chat/sessions/{id}`、`POST /api/chat/sessions/{id}/messages`

精确请求/响应、错误码和状态机以 `docs/contracts/` 为准。

## 验证

```bash
cd packages/ai-engine
uv run pytest -q
uv run ruff check .
uv run mypy ai_engine tools
```

需要真实 PostgreSQL 或真实 provider key 的验证必须单独标注；没有凭证时不要把 mock/fake 结果描述成真实链路通过。

## 边界

- `apps/web/prisma/schema.prisma`、`packages/shared/` 和 `docs/contracts/` 是共享契约；修改需要显式 review。
- TypeScript 与 Python 的错误码/状态镜像必须同时更新并测试。
- API secret 只通过环境注入，变量名以 `docs/contracts/env-and-scripts.md` 和 `.env.example` 为准。
