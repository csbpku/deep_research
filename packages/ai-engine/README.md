# packages/ai-engine — AI 与后台任务服务

FastAPI/Python 服务，负责 AI 调研适配、异步任务、技术雷达抓取与解读、导入/分享 worker、SSRF-safe URL fetch，以及摘要上下文 AI 讨论。

## 当前能力（2026-07-24）

- `adapters/`：统一 `ResearchEngineAdapter` 协议，提供 fake 与 Claude 实现。
- `job_runner/`：内存/数据库 store、幂等 replay、日配额、lease、reaper 和任务执行。
- `radar/`：GitHub、arXiv、RSS source 管理、抓取、同步与解释流水线。
- `fetcher/`：安全 URL fetch 与 Tavily/source URL 处理。
- `server/`：health、AI job、radar sync、share submission 和 chat endpoints。
- 顶层 worker：文件导入与分享提交处理。

`gpt-researcher` 是当前运行时主适配（Week 7 切回，ADR 0004 复评通过）；`fake` 是测试/CI fallback。Claude 适配（`adapters/claude.py`）已从 `build_adapter` 工厂移除，历史 spike 报告保留在 `reports/`，引擎选型见 `docs/decisions/0004-ai-engine-selection.md`。默认 retriever 为 tavily（`fetcher/tavily.py`），`TAVILY_API_KEY` 仍为必填。

## 目录

```text
packages/ai-engine/
├── ai_engine/
│   ├── adapters/           # fake / Claude adapter
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

需要真实 PostgreSQL 或真实 Claude key 的验证必须单独标注；没有凭证时不要把 mock/fake 结果描述成真实链路通过。

## 边界

- `apps/web/prisma/schema.prisma`、`packages/shared/` 和 `docs/contracts/` 是共享契约；修改需要显式 review。
- TypeScript 与 Python 的错误码/状态镜像必须同时更新并测试。
- API secret 只通过环境注入，变量名以 `docs/contracts/env-and-scripts.md` 和 `.env.example` 为准。
