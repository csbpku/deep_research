# Deep Research · 技术调研平台

> AI 帮我们读文章、抓热搜、看趋势；我们给反馈、踩坑记下来，团队的判断和经验会越攒越多。
> 一图看懂这个产品在做什么：[`docs/DIAGRAMS.md`](./docs/DIAGRAMS.md)
> 架构基线：[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) v3.6

[![CI](https://github.com/csbpku/deep_research/actions/workflows/ci.yml/badge.svg)](https://github.com/csbpku/deep_research/actions/workflows/ci.yml)

## 这个项目做什么

一个面向个人 / 小团队的技术调研与情报沉淀平台。AI 自动跟进 GitHub、arXiv、RSS 和成员分享的来源，提炼候选；人在阅读、做标注、转发给同事，团队对这些内容的判断会被保留、检索、再利用。

**核心能力**

- **技术雷达**：从 GitHub、arXiv、RSS 和用户分享持续发现候选，附 LLM 生成的轻量解读（覆盖 distilled 7 维评分 + audience-matched profile）。
- **每日摘要**：每天最多 4 条精选，从雷达池人工确认，含入选理由、标签、来源、可深读的详情页。
- **沉淀库**：长文与讨论精华共用同一结构，支持草稿 / 发布 / 全文搜索 / 修改审计。
- **文件导入**：上传 `.md / .txt / .html`，异步转成当前用户的私有 Markdown 草稿。
- **AI 调研**：给一个主题，启动异步 5 步流水线（研究 → 草拟 → 注入来源 → 校核 → 入库），用户必须实际修改过才能发布。
- **基础评论 + Admin**：雷达、摘要和沉淀都能评论；Admin 控制台统一处理雷达 promote、分享审核、评论提名和失败任务。
- **搜索与分享**：全文检索（PostgreSQL GIN / 触发器）+ 成员对外分享（URL 经 SSRF-safe 抓取 + LLM 摘要后入候选池）。
- **运行底线**：权限、成本埋点、结构化日志、`pg_dump` 备份恢复、SSH 部署脚手架。

完整的 P0 / P1 边界、测试指标、follow-up 与历史交付见 [`docs/PROJECT_STATUS.md`](./docs/PROJECT_STATUS.md)。

## 架构总览

```
┌──────────────────────────┐    ┌──────────────────────────┐
│  apps/web (Next.js 15)   │    │  packages/ai-engine      │
│  App Router + BFF        │    │  (FastAPI + Python 3.11) │
│  Prisma · NextAuth       │    │  adapters · job runner   │
│  评论 / Admin / 搜索     │◀──▶│  radar / import worker   │
└──────────┬───────────────┘    └──────────┬───────────────┘
           │                                │
           └────────────┬───────────────────┘
                        ▼
              ┌──────────────────────┐
              │  PostgreSQL 16       │
              │  业务库 + 任务队列表 │
              │  + 全文索引 + metric │
              └──────────────────────┘
                        ▲
                        │
              ┌─────────┴───────────┐
              │ infra/              │
              │ nginx · Dockerfiles │
              │ pg-backup · restore │
              └─────────────────────┘
```

- **`apps/web/`** —— 用户能看到的：登录、雷达列表、每日摘要、沉淀详情 / 编辑、文件导入、管理员控制台。
- **`packages/ai-engine/`** —— 后台长任务：调研 5 步流水线、雷达抓取与同步、文件导入转换、分享提交、SSRF-safe URL fetch、Tavily retriever。
- **`packages/shared/`** —— TypeScript ↔ Python 镜像的 Zod schema、错误码、状态枚举；A/B 双方向只读，修改走 `[shared]` PR。
- **`infra/`** —— `docker-compose.yml` + nginx + 多阶段 Dockerfile + `pg-backup.sh` / `pg-restore.sh` / `import-tmp-cleanup.sh`。
- **契约层** —— `docs/contracts/` 定义了所有跨边界字段的 single source of truth；改 schema 走 ADR。

更多见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)、[`docs/DIAGRAMS.md`](./docs/DIAGRAMS.md)、[`docs/wiki/development.md`](./docs/wiki/development.md)。

## 技术栈

| 层 | 选型 |
|---|---|
| Frontend / BFF | Next.js 15（App Router）、React 19、TypeScript、Vitest、Playwright、NextAuth、Prisma |
| AI / 后台 | Python 3.11、FastAPI、Pydantic、psycopg、`gpt-researcher` 主适配（`fake` 作 fallback）、Tavily retriever、uv |
| 数据库 | PostgreSQL 16 + `pg_trgm` 模糊检索，`tsvector` 全文索引；migration 由 Prisma 管理 |
| 部署 | Docker Compose + nginx 1.27（HTTP-only，TLS 模板待签发），本地/单 VPS |
| 工具链 | pnpm workspace（10+）、uv、ruff + mypy、tsc、GitHub Actions CI |

外部依赖：Anthropic / OpenAI（按 adapter）、Tavily、Google OAuth。

## 本地部署（最快路径）

**前置条件**：Node.js ≥ 20.11、pnpm ≥ 10、Python ≥ 3.11、uv、PostgreSQL 16（Homebrew 或 Docker）。详见 [`docs/wiki/getting-started.md`](./docs/wiki/getting-started.md)。

```bash
# 1. 克隆仓库
git clone https://github.com/csbpku/deep_research.git
cd deep_research

# 2. 一键配置 —— 交互模式：检测环境 → 装依赖 → 生成 .env → 建库 → 跑 migration
./scripts/setup.sh

# 想先看 UI 不配任何 API key?用 --quick：自动用 fake adapter
./scripts/setup.sh --quick

# 想直接 docker compose 起来?
./scripts/setup.sh --docker

# 3. 起服务（两个终端）
pnpm dev:web     # → http://localhost:3000
pnpm dev:ai      # → http://localhost:4000
```

Docker 模式：

```bash
cp .env.example .env        # 填 OPENAI_API_KEY / TAVILY_API_KEY / NEXTAUTH_SECRET
docker compose -f infra/docker-compose.yml --env-file .env up -d --build
curl -fsS http://localhost:3000/api/healthz      # web
curl -fsS http://localhost:4000/healthz          # ai-engine
```

`scripts/setup.sh` 会自动生成 `NEXTAUTH_SECRET` 等随机密钥、创建本地 Postgres、跑 Prisma migration。环境变量全字段见 [`docs/contracts/env-and-scripts.md`](./docs/contracts/env-and-scripts.md)。

### 验证

```bash
pnpm typecheck
pnpm test                      # vitest 单测
pnpm --filter @deep-research/web exec playwright test --project=chromium   # E2E
cd packages/ai-engine && uv run pytest -q && uv run ruff check . && uv run mypy ai_engine tools
```

## 仓库布局

| 路径 | 作用 |
|---|---|
| `apps/web/` | Next.js 15 Web + BFF + Prisma + Vitest / Playwright |
| `packages/ai-engine/` | FastAPI + `gpt-researcher` 适配 + radar / import worker + SSRF-safe fetch |
| `packages/shared/` | 跨 runtime 的 Zod schema、错误码、状态枚举（双方只读） |
| `infra/` | `docker-compose.yml`、nginx、Dockerfile、`pg-backup.sh`、`pg-restore.sh` |
| `docs/contracts/` | API / 状态 / 错误 / env / metric / URL 安全契约（single source of truth） |
| `docs/decisions/` | ADR（架构决策记录） |
| `docs/wiki/` | 项目 wiki：上手 / 开发 / 部署 / 运维 |
| `scripts/` | 仓库根 helper：`setup.sh`、`cost_extrapolation.py`、`test-local-env.sh` |

## 文档地图

| 我想…… | 看这里 |
|---|---|
| 第一次 clone 跑起来 | [`docs/wiki/getting-started.md`](./docs/wiki/getting-started.md) |
| 理解代码怎么分工、怎么改 | [`docs/wiki/development.md`](./docs/wiki/development.md) |
| 部署到一台机器 / 备份恢复 | [`docs/wiki/deployment.md`](./docs/wiki/deployment.md) + [`infra/README.md`](./infra/README.md) |
| 跑试用、收集反馈 | [`docs/wiki/operations.md`](./docs/wiki/operations.md) |
| 看当前进度 / 测试指标 / follow-up | [`docs/PROJECT_STATUS.md`](./docs/PROJECT_STATUS.md) |
| 看架构方案和取舍 | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |
| 看逐周实施与验收 | [`docs/IMPLEMENTATION_PLAN.md`](./docs/IMPLEMENTATION_PLAN.md) |
| 共享契约（schema / API / 状态） | [`docs/contracts/`](./docs/contracts/) |
| 历史决策 | [`docs/decisions/`](./docs/decisions/) |
| 按周交付记录 | [`docs/weekly/`](./docs/weekly/) |

## 当前状态

截至 2026-07-30：Week 7–9 已完成（gpt-researcher 主适配 / 评论 / Admin / 部署脚手架 / 回归与安全）。进入 **Week 10–13 试用冻结期** —— 不新增 P0，仅修 S0/S1 bug。Week 13 之后做 Go/No-Go 决策。

测试基线（详细见 `PROJECT_STATUS.md`）：

- Web 单测 253、E2E 21 passed / 2 skipped
- Python 单测 270 + 1 skipped、E2E 11 passed / 2 skipped
- `pnpm typecheck`、`uv run ruff check .` 全绿

## 贡献

这是一个个人项目仓库，目前不接受外部 PR。新克隆按 `scripts/setup.sh` 即可起，按 [`docs/wiki/development.md`](./docs/wiki/development.md) 的工程师 A / B 边界与 PR 约定工作。在 [`docs/decisions/`](./docs/decisions/) 里有完整的 ADR 索引可参考。

## License

UNLICENSED. Personal project.
