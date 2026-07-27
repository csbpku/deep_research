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
- `docs/weekly/`: historical delivery evidence; current behavior belongs in README/contracts, not duplicated here
- Preserve unrelated working-tree changes. Do not delete branches, worktrees, reports, caches, or temporary artifacts without post-report user confirmation.

## Current State

- As of 2026-07-27, Week 7 is complete: 3 real Chinese-topic e2e research runs succeeded, private draft permissions and SHA-256 publish guard verified via real API.
- Week 8 (basic comments, Admin, deployment and recovery) is next according to `docs/IMPLEMENTATION_PLAN.md`.
- `infra/docker-compose.yml` is a deployment scaffold, not a verified deployment: referenced Dockerfiles are currently absent.
