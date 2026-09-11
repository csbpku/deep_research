# Project Agent Guide

## Project

Personal technical-research platform: radar discovery, topic follow-up, saved research, imports, AI research, search, sharing, and admin workflows.

## Run And Verify

- Install: `pnpm install`
- Web: `pnpm dev:web` (`http://localhost:3000`)
- AI engine: `pnpm dev:ai` (`http://localhost:4000`)
- Generate Prisma client: `pnpm db:generate`
- Typecheck: `pnpm typecheck`
- Tests: `pnpm test`
- Python quality gates: `cd packages/ai-engine && uv run ruff check . && uv run mypy ai_engine tools`

## Stack

- Next.js 15, React 19, TypeScript, Vitest, Tailwind, NextAuth, Prisma
- Python 3.11, FastAPI, Pydantic, psycopg, pytest, ruff, mypy
- PostgreSQL 16; pnpm workspace + uv

## Layout And Conventions

- `apps/web/`: pages, BFF routes, auth, Prisma client, and Web tests
- `packages/ai-engine/`: adapters, workers, radar ingestion, job runner, chat API, and Python tests
- `packages/shared/`: cross-runtime states, errors, and schemas; keep TypeScript and Python mirrors aligned
- `apps/web/prisma/`: shared database contract; schema or migration changes require explicit review
- `docs/contracts/`: API, state, error, metric, and environment contracts
- `docs/PROJECT_STATUS.md`: 项目总览（进度、测试、follow-up）— 任何 agent 会话第一站
- `docs/weekly/`: historical delivery evidence; current behavior belongs in README/contracts, not duplicated here
- Preserve unrelated working-tree changes. Do not delete branches, worktrees, reports, caches, or temporary artifacts without post-report user confirmation.

## Current State

- **入口文档**：[`docs/PROJECT_STATUS.md`](./docs/PROJECT_STATUS.md) — 当前进度、测试指标、follow-up bug、文档地图；文档分层见 [`docs/README.md`](./docs/README.md)。
- As of 2026-09-11: Weeks 1–13 / P1 / cognition-loop V2 已交付；当前继续收口 AI 调研产物、深度研究、雷达正文质量和全站体验。`main` 已包含 Hugging Face 可配置请求源、Zread 限流恢复、enrichment 限流隔离、可选 browser-review profile 和 HTTP UUID 兼容；发布与线上事实以 [`docs/PROJECT_STATUS.md`](./docs/PROJECT_STATUS.md) 顶部条目为准。
- AI engine: `GptResearcherAdapter` is primary (ADR 0004 复评通过), `FakeAdapter` is the test/CI fallback. Canonical LLM slots 是 `<provider>:<model>` 形式的 `RESEARCH_LLM` / `UTILITY_LLM` / `FALLBACK_LLM`（fallback 兼容读取旧名 `LLM_FALLBACK_LLM`；`SMART_LLM` 等旧槽位仅作 gpt-researcher 兼容镜像，派生逻辑见 `ai_engine/llm/config.py`）；`scripts/setup.sh` discovers `/models` and writes the selected model to the canonical slots, while `--quick`/fake uses `anthropic:deepseek-v4-flash`. Heavy calls prefer `*_HEAVY` credentials and fall back to the light pair. 只有 `RETRIEVER=tavily` 时才需要 `TAVILY_API_KEY`。
- Week 9 交付详见 `docs/weekly/week9-delivery.md`。
- P1 已交付：研究文章三栏工作台、雷达讨论与治理、Confluence 导入框架（OAuth 仍需外部凭据验收）、AI 事实核验与结论审查；日报生成链路已删除。本周新增/收口知识卡片显式提炼、研究库状态/类型筛选、AI 调研四种产物（研究稿、快速判断、Slides 提纲、网页简报）和独立审核边界。
- 雷达详情当前为“摘要先行 + 原文阅读动作栏”：文章地图只允许严格正文 block 回链，选中文本支持解释/翻译/问 AI/批注/复制引用；HTML 正文图片会保留为安全 HTTPS 图片并懒加载。高价值 enrichment 还会经过内容呈现审核和真实浏览器渲染审核，二者与 AI 研究事实审核分开。
- 部署脚手架 `infra/` 已就绪，Docker Compose 镜像构建及备份恢复演练已完成。
- 默认生产 Compose 拓扑为 PostgreSQL、Web、AI engine、nginx；真实 Chromium 页面审核属于可选 `browser-review` profile，不进入默认 GHCR 发布。AnythingLLM 是可选的 HTTP 讨论后端，生产 URL、workspace 和凭据只保留在 VPS `.env`。
- 本地运行：`launchd` 模板（`infra/launchd/`）支持常驻 AI engine（uvicorn 直接运行，无 `--reload`）和 Next.js 服务。
- **收口门禁**：以 `docs/PROJECT_STATUS.md` 顶部条目记录的本次实际结果为准；不要把历史周报或未在本次重跑的数量写成新基线。
- **已移除/废弃**：`apps/web/src/app/api/admin/radar/[id]/select/route.ts`（逐条选入日报接口已移除；当前雷达由自动排序与 Admin 负向治理处理）。
- **Next 构建目录**：开发环境默认使用 `apps/web/.next-dev`，production/隔离构建默认使用 `.next`；`NEXT_DIST_DIR` 仍可覆盖输出目录。`.next-*` 是本地构建残留，未经确认不要删除。
