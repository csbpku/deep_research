# 技术方案总览

> 当前现役技术方案的唯一摘要。更新日期：2026-09-14。
> 真实部署、测试和线上运行证据仍按日期记录在 [`PROJECT_STATUS.md`](./PROJECT_STATUS.md)；
> 本文不记录开发过程流水账。

## 1. 项目边界

Deep Research 是面向个人和小团队的技术调研平台，负责：

- 从 GitHub、arXiv、RSS、厂商更新和社区来源发现技术候选；
- 对候选做正文抽取、AI 解读、Distilled 评分和阅读等级分层；
- 按专题聚合候选，生成热点议题和带引用的专题综述；
- 支持 AI 调研、研究稿、快速判断、Slides 提纲、网页简报和知识卡片；
- 支持登录、收藏、批注、评论、分享、全文搜索和 Admin 治理。

当前不追求高可用多机部署、异地数据库自动切换或公开注册。生产目标是单 VPS、受控账号、可恢复后台任务和可验证的内容质量。

## 2. 运行拓扑

| 部件 | 责任 | 本地原生 | Docker / VPS |
|---|---|---|---|
| `apps/web` | Next.js 页面、BFF、NextAuth、Prisma | `3000` | `web:3000` |
| `packages/ai-engine` | FastAPI、LLM、雷达和后台 worker | `4000` | `ai-engine:4000` |
| PostgreSQL | 业务数据、队列、全文索引 | `5432` | `postgres:5432` |
| nginx | 公网反代、上传限制、健康路由 | 可选 | `80/443` |
| AnythingLLM | 可选 AI 讨论后端 | 独立服务 | 独立服务 |

默认生产 Compose 只运行 PostgreSQL、Web、AI engine 和 nginx。Chromium `render-review` 是可选 profile，不属于默认生产资源预算。

## 3. 核心数据流

### 雷达

```text
source sync
  -> candidate persistence
  ->正文抓取 / enrichment
  -> utility LLM brief + distilled score
  -> reader quality
  -> content review
  -> topic refresh / topic issue
```

每一层都保留自己的状态和失败原因。网络失败、正文不完整、评分缺失、内容审核未完成和主题聚类失败不能互相伪装成成功。

### Enrichment 与审核

- `distilledTargetTier` 保存评分得到的目标层级；`distilledTier` 只表示当前可交付层级。目标为 `collection/deep_read` 但 enrichment 未完成时，实际层级必须是 `skim`，完成 source snapshot 和 reader quality 后才恢复目标层级；数据库 trigger 负责兜底这一不变量。
- `enrichmentStatus` 表示来源正文资产是否完成；
- `readerQualityStatus` 表示正文是否满足阅读质量门槛；
- `contentReviewStatus` 表示当前正文内容审核结果；
- `renderReviewStatus` 只属于可选 Chromium 页面审核，不是默认交付门槛。

当前默认审核路径是“正文质量检查 + 内容审核 + 可恢复 reconciliation”。历史 Chromium `unavailable` 不能代表当前内容审核失败；关闭 browser-review 时不会启动 Chromium，也不会重新创建 render 队列。

### AI 调研

Web 先创建可追踪任务，AI engine 通过 durable job store 异步执行研究、草拟、来源绑定、事实核验和产物入库。HTTP 请求只负责提交、查询和取消，不在请求线程内等待完整研究。

## 4. LLM 路由

业务代码只选择用途，不直接绑定供应商：

| 用途 | 环境变量 | 默认职责 |
|---|---|---|
| 重量级研究 | `RESEARCH_LLM` | gpt-researcher 主流程 |
| 工具型调用 | `UTILITY_LLM` | 评分、摘要、审核、聊天、热点聚类 |
| 统一备用 | `FALLBACK_LLM` | 主路由失败后的 fallback |

格式统一为 `<provider>:<model>`。当前默认模型路由为 MiniMax 主模型、DeepSeek fallback；凭据只通过运行时环境注入。旧的 `SMART_LLM`、`FAST_LLM`、`STRATEGIC_LLM`、`BRIEF_LLM` 只作为兼容镜像，不是业务真相源。

共享 LLM client 负责有限重试、fallback、endpoint 熔断和 token usage 审计。业务 worker 仍必须提供自己的确定性降级或可恢复状态，不能用空结果冒充成功。

## 5. 认证与权限

- 默认开放邮箱密码注册/登录；
- Google 和 GitHub OAuth 可选，均不限制邮箱域；`AUTH_GOOGLE_ONLY=1` 是兼容旧部署的开关，仅保留 Google；
- `ALLOWED_EMAIL_DOMAINS` 和 `AUTH_INVITE_CODE` 仅供旧 `/api/auth/activate` 兼容接口使用，不参与公开注册或 OAuth；
- `shaobo.chen@shopee.com` 是默认 bootstrap Admin；
- Admin、成员和匿名访问由 Web BFF 服务端校验，前端隐藏不是权限边界；
- 生产密码登录必须使用 HTTPS。

## 6. 本地服务生命周期

日常开发使用：

```bash
pnpm dev:web    # http://localhost:3000
pnpm dev:ai     # http://localhost:4000
brew services start postgresql@16
```

如果使用 `infra/launchd/` 的 macOS 常驻模板，模板中的 `KeepAlive=true` 会在子进程退出后自动拉起服务。彻底停止本地常驻服务时，必须同时卸载 launchd job 和 PostgreSQL：

```bash
launchctl bootout gui/$(id -u)/com.deep-research.web
launchctl bootout gui/$(id -u)/com.deep-research.ai
brew services stop postgresql@16
```

这不会删除 plist、代码或数据库。以后恢复时按顺序启动：

```bash
brew services start postgresql@16

launchctl bootstrap gui/$(id -u) \
  "$HOME/Library/LaunchAgents/com.deep-research.ai.plist"
launchctl bootstrap gui/$(id -u) \
  "$HOME/Library/LaunchAgents/com.deep-research.web.plist"
```

检查服务：

```bash
launchctl list | rg 'com\.deep-research'
brew services list | rg 'postgresql@16'
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:4000 -sTCP:LISTEN
lsof -nP -iTCP:5432 -sTCP:LISTEN
curl -fsS http://127.0.0.1:3000/api/healthz
curl -fsS http://127.0.0.1:4000/healthz
```

代码变更后，launchd Web 使用的是 `next start`，需要先重新构建：

```bash
pnpm --filter @deep-research/web build
```

## 7. 部署策略

### 新克隆 / 本地 Docker

```bash
./scripts/setup.sh --quick
pnpm db:deploy
pnpm db:generate
```

Web entrypoint 和 setup 都会幂等补齐默认雷达源，并引导 bootstrap Admin。默认源、认证、环境变量和脚本契约分别见：

- [`docs/contracts/env-and-scripts.md`](./contracts/env-and-scripts.md)
- [`apps/web/.env.example`](../apps/web/.env.example)
- [`packages/ai-engine/.env.example`](../packages/ai-engine/.env.example)

### GHCR + 固定 SHA + VPS

GitHub Actions 在 CI 通过后构建 Web 和 AI engine 的 Linux/amd64 镜像，推送不可变 commit SHA 标签；VPS 只拉取该 SHA，不在生产机重新构建。VPS `.env`、数据库卷、备份和日志不进入镜像。

发布后至少验证：

```bash
docker compose ps
curl -fsS https://<host>/healthz
curl -fsS https://<host>/ai-healthz
```

健康检查不等于功能验收。雷达同步、评分、enrichment、内容审核、热点议题和真实 LLM 调研要按 [`FUNCTIONAL_CHECKLIST.md`](./FUNCTIONAL_CHECKLIST.md) 验证。

## 8. 文档分层

| 文档 | 只保留什么 |
|---|---|
| `TECHNICAL_OVERVIEW.md` | 当前技术方案的单页摘要 |
| `ARCHITECTURE.md` | 产品边界、数据模型、状态和安全的详细设计 |
| `FUNCTIONAL_CHECKLIST.md` | 用户功能、失败恢复和验收路径 |
| `contracts/` | API、状态、错误、环境和指标的共享契约 |
| `decisions/` | 不可逆架构和产品决策 |
| `infra/README.md`、`wiki/` | 部署、开发和运维操作手册 |
| `PROJECT_STATUS.md` | 带日期的测试、部署、线上事实和未闭合风险 |
| `weekly/`、`archive/` | 历史交付、旧计划、旧评审和原始证据 |

历史文档不应被当作当前实现说明。当前行为以代码、契约和本文为准；历史数字只有在带日期并且与当前运行态对应时才可引用。

## 9. 当前验证边界

- 代码、schema、Compose 和默认环境变量以当前 `main` 工作树为准；
- 本地原生服务可以通过 launchd 常驻，也可以完全卸载；
- 默认生产部署不启用 Chromium；
- 真实 VPS 的部署 marker、数据库统计和功能验收必须写入带日期的 `PROJECT_STATUS.md`；
- 未在本轮重新执行的测试或线上统计不能被写成新的基线。
