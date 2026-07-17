# packages/ai-engine

AI 调研引擎、Fetch/Compress/Write 轻量路径、SSRF-safe URL fetcher。
工程师 B：AI / 平台 独占领地。其他角色可读，不写。

## 模块边界

```
packages/ai-engine/
├── ai_engine/
│   ├── adapters/           # ResearchEngineAdapter（fake / claude / gpt-researcher）
│   ├── fetcher/            # SSRF-safe URL fetcher（架构 §九 风险 5 + 5b）
│   ├── summary/            # 摘要轻量模式（reportType=summary_brief）
│   ├── research/           # 五步调研流水线（架构 §九 风险 4）
│   ├── job_runner/         # DB-backed 任务执行 + 心跳 + cancel
│   ├── server/             # FastAPI app（apps/web 通过 /ai/* 转发）
│   └── clients/            # Postgres / Redis / Tavily / arxiv-mcp / GitHub API
├── tests/
└── pyproject.toml
```

## 本地开发

```bash
uv sync                          # 自动 .venv + 装依赖（Python 3.11）
uv run pytest
uv run uvicorn ai_engine.server.app:app --reload --port 4000
```

## 共享契约（只读）

- `packages/shared/src/errors.ts` → TS 类型
- `apps/web/prisma/schema.prisma` → 数据库结构（只读；可 validate/generate，不迁移或手写 SQL）
- 错误码 / 状态机 / env 名见根 README 与 `docs/contracts/`
