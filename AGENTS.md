# Project Agent Guide

## Project

Personal technical-research platform: radar discovery, daily summaries, saved research, imports, AI research, search, sharing, and admin workflows.

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

- **入口文档**：[`docs/PROJECT_STATUS.md`](./docs/PROJECT_STATUS.md) — 当前进度、测试指标、follow-up bug、文档地图。
- As of 2026-08-06, Weeks 1–13 are complete. Trial freeze (W10–13) done; Go/Adjust/Stop evidence still pending.
- AI engine: `GptResearcherAdapter` is primary (ADR 0004 复评通过), `FakeAdapter` is the test/CI fallback. `adapters/claude.py`（`ClaudeAdapter`）已从 `build_adapter` 工厂移除但文件仍在仓库（dead code，候选清理）。`fetcher/tavily.py` 仍在使用——gpt-researcher 默认 retriever 为 tavily，`TAVILY_API_KEY` 仍为必填。
- Week 9 交付详见 `docs/weekly/week9-delivery.md`。
- P1 已交付：研究文章三栏工作台（版本/大纲/AI 助手/AI 校核/引用/锚定评论）、雷达讨论与治理（@成员/站内通知、软屏蔽/恢复）、Confluence 导入框架（代码完成，OAuth 需外部凭据验收）、AI 事实核验与结论审查。
- 部署脚手架 `infra/` 已就绪，Docker Compose 镜像构建及备份恢复演练已完成。
- 本地运行：`launchd` 模板（`infra/launchd/`）支持常驻 AI engine（uvicorn 直接运行，无 `--reload`）和 Next.js 服务。
- **测试指标**（2026-08-06 实测）：Web 单测 383 ✅、Web E2E 33 passed/2 skipped ✅、Python 全量测试 443 passed/1 skipped ✅、typecheck + ruff 全绿、mypy 66 files 0 issues ✅。详见 PROJECT_STATUS.md。
- **lint gate 状态**：`ruff check .` 与 `mypy ai_engine` 均 clean（66 个源文件）。
- **已移除/废弃**：`apps/web/src/app/api/admin/radar/[id]/select/route.ts`（逐条选入日报接口已移除，由自动日报取代）。
- **备用 `distDir`**：`next.config.ts` 支持 `NEXT_DIST_DIR` 环境变量，用于隔离 production build 路径。

