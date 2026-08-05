# Deep Research · 技术调研平台

> AI 帮我们读文章、抓热搜、看趋势；我们给反馈、踩坑记下来，团队的判断和经验会越攒越多。
> 一图看懂这个产品在做什么：[`docs/DIAGRAMS.md`](./docs/DIAGRAMS.md)
> 架构基线：[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) v3.6

[![CI](https://github.com/csbpku/deep_research/actions/workflows/ci.yml/badge.svg)](https://github.com/csbpku/deep_research/actions/workflows/ci.yml)

## 这个项目做什么

一个面向个人 / 小团队的技术调研与情报沉淀平台。AI 自动跟进 GitHub、arXiv、RSS、WeWe RSS 微信公众号和成员分享的来源，提炼候选；人在阅读、做标注、转发给同事，团队对这些内容的判断会被保留、检索、再利用。

**核心能力**

- **技术雷达**：从 GitHub、arXiv、RSS、WeWe RSS 微信公众号和用户分享持续发现候选，附 LLM 生成的轻量解读（覆盖 distilled 7 维评分 + audience-matched profile）。
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

## 本地部署

### 前置条件

- 原生模式：Node.js ≥ 20.11、pnpm ≥ 10、Python ≥ 3.11、uv、PostgreSQL 16。
- Docker 模式：Docker Engine 24+ 与 Compose v2；建议至少 2 vCPU / 4 GB RAM。
- 真实 AI：一个受支持 provider 的 API key，以及 Tavily key（或将 `RETRIEVER=duckduckgo`）。只验 UI 可用 `AI_ENGINE_ADAPTER=fake`。
- Google OAuth：创建 Web application，并登记 `http://localhost:3000/api/auth/callback/google`。

### 原生启动

```bash
# 1. 克隆仓库
git clone https://github.com/csbpku/deep_research.git
cd deep_research

# 2. 检测环境、安装依赖、生成 env、建库并执行 migration
./scripts/setup.sh

# 不配 AI key，只验证产品 UI 与流程
./scripts/setup.sh --quick

# 3. 起服务（两个终端）
pnpm dev:web     # → http://localhost:3000
pnpm dev:ai      # → http://localhost:4000
```

首次登录前，在 Google OAuth 控制台登记回调 URL，确认 `ALLOWED_EMAIL_DOMAINS` 包含登录邮箱域名。`BOOTSTRAP_ADMIN_EMAIL` 可在首次启动时幂等创建/提升初始 Admin；也可稍后由已有 Admin 在成员管理中调整角色。

### 本地 Docker

```bash
cp .env.example .env
# 至少替换 POSTGRES_PASSWORD、NEXTAUTH_SECRET、INTERNAL_SERVICE_TOKEN，
# 并填写 ALLOWED_EMAIL_DOMAINS、Google OAuth 和所选 AI provider 凭证。
docker compose --env-file .env -f infra/docker-compose.yml config --quiet
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
curl -fsS http://localhost:3000/api/healthz      # web
curl -fsS http://localhost:4000/healthz          # ai-engine
docker compose --env-file .env -f infra/docker-compose.yml ps
```

容器启动时 Web entrypoint 自动执行 `prisma migrate deploy` 和可选的 Admin bootstrap。PostgreSQL 只绑定 `127.0.0.1:5432`；生产环境不要改成公网监听。环境变量全字段见 [`docs/contracts/env-and-scripts.md`](./docs/contracts/env-and-scripts.md)。

### 验证

```bash
pnpm typecheck
pnpm test                      # vitest 单测
pnpm --filter @deep-research/web exec playwright test --project=chromium   # E2E
cd packages/ai-engine && uv run pytest -q && uv run ruff check . && uv run mypy ai_engine tools
```

## 单 VPS 生产部署

推荐 Ubuntu 24.04 LTS、2 vCPU / 4 GB RAM 起步、独立域名和非 root 运维账号。以下是当前仓库已支持的单机拓扑；高可用、多机数据库和集中监控不在当前范围。

1. DNS：将域名的 `A/AAAA` 记录指向 VPS；先等待解析生效。
2. 主机：安装 Docker Engine/Compose，克隆到 `/opt/deep_research`，只允许 SSH、80、443 入站；不要放行 3000、4000、5432。
3. Secrets：复制 `.env.example` 为 `.env`，权限设为 `600`；用 `openssl rand -hex 32` 分别生成数据库、NextAuth 和内部服务令牌。设置 `NEXTAUTH_URL=https://research.example.com`，并把 Google OAuth 回调登记为 `https://research.example.com/api/auth/callback/google`。
4. 配置：填写 `ALLOWED_EMAIL_DOMAINS`、`BOOTSTRAP_ADMIN_EMAIL`、AI provider 与检索凭证。`.env` 不提交 Git，不写入镜像。
5. TLS：用 Certbot/acme.sh 签发 `fullchain.pem` 与 `privkey.pem`，放入 `infra/certs/`（私钥 `0600`）；将 Compose 的 nginx mount 从 `infra/nginx.conf` 切换为 `infra/nginx-tls.conf`。证书签发前不要公开登录流量。
6. 启动：先校验配置，再构建启动；检查容器、HTTPS 和两项 health endpoint。

```bash
cd /opt/deep_research
cp .env.example .env
chmod 600 .env
docker compose --env-file .env -f infra/docker-compose.yml config --quiet
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
docker compose --env-file .env -f infra/docker-compose.yml ps
curl -fsS https://research.example.com/healthz
curl -fsS https://research.example.com/ai-healthz
```

部署后必须实际登录一次，确认 Admin 仪表板、雷达同步、文件导入和 AI 调研可用。日志用 `docker compose ... logs --since=30m web ai-engine nginx` 查看。

备份、升级和回滚：每天运行 `infra/pg-backup.sh` 并把备份复制到异机/对象存储；定期在隔离库执行 `infra/pg-restore.sh`。升级前先备份和记录当前 Git SHA/镜像，`git pull` 后重建；若健康检查或 smoke 失败，切回原 SHA/镜像并恢复兼容备份。完整命令、TLS、cron、故障排查见 [`docs/wiki/deployment.md`](./docs/wiki/deployment.md)。

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

截至 2026-08-05：已对 22 个页面和核心闭环完成两遍真实浏览器验收，包括真实 Markdown 导入、模板套用、搜索分页、关注/收藏、偏好带入、Admin 全队列，以及带 required Radar 来源的真实 AI 调研。修复后的 AI brief 会解析并校验内部/URL `sourceRefs`，严格执行 `only_user_sources`，不再把 0 来源空内容标为成功。生产构建、Web/AI Docker 镜像、真实数据库备份恢复均已验收；本轮测试账号及关联数据、临时文件已逐项清零。平台仍未宣称 product-ready：公网 TLS 实签、VPS 上线 smoke、监控告警和真实用户 Go/Adjust/Stop 数据仍待完成。

测试基线（详细见 `PROJECT_STATUS.md`）：

- Web 单测 305/305，shared schema 单测 5/5；浏览器 E2E 全量集合 33 passed / 2 skipped
- Python 371 passed / 1 skipped
- `pnpm typecheck`、`ruff`、`mypy`、生产 `pnpm build` 全绿
- `docker compose build web ai-engine` 成功；带数据备份恢复逐表精确计数一致

## 贡献

这是一个个人项目仓库，目前不接受外部 PR。新克隆按 `scripts/setup.sh` 即可起，按 [`docs/wiki/development.md`](./docs/wiki/development.md) 的工程师 A / B 边界与 PR 约定工作。在 [`docs/decisions/`](./docs/decisions/) 里有完整的 ADR 索引可参考。

## License

UNLICENSED. Personal project.
