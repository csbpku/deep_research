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
- As of 2026-07-28, Week 7 is complete (AI engine switched from `simple-claude-pipeline` to `gpt-researcher`, ADR 0004 复评通过; `GptResearcherAdapter` is the primary engine, `FakeAdapter` remains the test/CI fallback; `ClaudeAdapter` and `fetcher/tavily.py` removed) and Week 8 is complete (M4 审核闭环 code + gates + 验收通过，详见 `docs/weekly/week8-delivery.md`).
- Week 8 deliverables now in repo: `CommentSection.tsx` + 6 评论 BFF routes + 6 Admin routes (dashboard / comments list & promote & dismiss / shares list & review) + `infra/{web,ai-engine}.Dockerfile` + `infra/{docker-compose.yml,nginx.conf,pg-backup.sh,pg-restore.sh,import-tmp-cleanup.sh}` + `apps/web/src/app/api/healthz/route.ts`. `infra/docker-compose.yml` + Dockerfiles are deployment scaffolds, not live-verified builds; live build + 备份恢复演练 explicitly deferred to Week 9 验收门.
- Pending Week 9 (§十一, M5 试用就绪): 评论/Admin 端点专属单测 + 全量权限矩阵 + 10 AI 样本 + 20 导入样本 + 备份恢复演练 + 月成本外推 ≤ $200 + 4 个决策指标基线快照 + 试用名单 + GitHub Actions CI 配置。Week 9 frozen scope: 不新增 P0 功能。
- **测试指标**（2026-07-28 实测）：Web 单测 303 ✅、Web E2E 21 passed/2 skipped ✅、Python 单测 193 ✅、Python E2E 11 passed/2 skipped ✅。详见 PROJECT_STATUS.md。
