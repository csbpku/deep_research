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
- As of 2026-07-30, Weeks 7–9 are complete. AI engine: `GptResearcherAdapter` is primary (ADR 0004 复评通过), `FakeAdapter` is the test/CI fallback. `adapters/claude.py`（`ClaudeAdapter`）已从 `build_adapter` 工厂移除但文件仍在仓库（dead code，候选清理）。`fetcher/tavily.py` 仍在使用——gpt-researcher 默认 retriever 为 tavily（line 408 `os.environ.setdefault("RETRIEVER", "tavily")`），`TAVILY_API_KEY` 仍为必填。
- Week 9 新增：`ai_engine/scoring/`（audience-matched Distilled v2 打分）+ `radar/distilled_scorer.py`（7-dimension LLM 评分）+ `shared/src/schemas.ts` 的 `DistilledScore` schema + `apps/web/src/components/radar/DistilledScorePanel.tsx` + helper scripts（`scripts/setup.sh`、`scripts/docker-entrypoint-web.sh`、`packages/ai-engine/scripts/{run_full_sync,sample_score,score_existing}.py`）。Week 9 交付详见 `docs/PROJECT_STATUS.md`（`docs/weekly/week9-delivery.md` 尚未创建）。
- 部署脚手架 `infra/{docker-compose.yml,nginx.conf,web.Dockerfile,ai-engine.Dockerfile,pg-backup.sh,pg-restore.sh,import-tmp-cleanup.sh}` 已就绪，live build + 备份恢复数据演练仍待做。
- 进入试用冻结期（Week 10–13）：不新增 P0 功能，仅修 S0/S1。剩余待办：10 AI 样本 + 20 导入样本 + 月成本外推 + 带数据备份恢复演练。
- **测试指标**（2026-07-30 实测）：Web 单测 303 ✅、Web E2E 21 passed/2 skipped ✅、Python 单测 193 + 51（distilled_scorer）= 244 ✅、Python E2E 11 passed/2 skipped ✅、typecheck + ruff 全绿、mypy 3 pre-existing errors（`gpt_researcher.py`，非本周改动）。详见 PROJECT_STATUS.md。
- **lint gate 状态**：`cd packages/ai-engine && uv run ruff check .` ✅ clean；`uv run mypy ai_engine tools` 有 3 个 pre-existing errors（`adapters/gpt_researcher.py`：`OpenAIEmbeddings` keyword args + unused type:ignore），来自 Week 7 commit `bc2af08`，非本次改动引入。
