# 技术调研平台

> 个人深度研究/技术调研平台。架构基线：`docs/ARCHITECTURE.md` v3.6。
> 实施计划：`docs/IMPLEMENTATION_PLAN.md` v1.3（9 周开发 + 4 周试用）。

## 当前状态（2026-07-24）

- Week 6 已合入 `main`：技术雷达、每日摘要、沉淀/导入、分享、搜索、AI 任务、幂等与配额、摘要上下文 AI 讨论均已有代码与测试覆盖。
- Week 6 收尾已提交（commit 1a0253d）：AI 讨论抽屉、雷达种子调研预填、Next.js 15 异步路由修复和文档同步。自动化门禁全绿。
- 真实 API walkthrough（3 次同步 + 2 次每日摘要发布）的前置凭据已就绪（Google OAuth、Claude key、GitHub trending 无需 token），但 walkthrough 本身尚未执行。
- Week 7 的 AI 调研端到端流程是下一阶段，详见 `docs/IMPLEMENTATION_PLAN.md` 与 `docs/weekly/week6-delivery.md`。
- `infra/docker-compose.yml` 仍是部署脚手架；引用的 Dockerfile 尚未入库，尚未完成 Week 8 部署验收。

## 仓库布局（monorepo）

| 路径 | 角色 | 谁拥有 |
|---|---|---|
| `apps/web/` | Next.js 15（App Router）Web 应用 + BFF + Prisma | **工程师 A：Web / 产品流** 独占 |
| `packages/ai-engine/` | Claude/fake adapter、异步任务、雷达抓取与后台 worker | **工程师 B：AI / 平台** 独占 |
| `packages/shared/` | 类型（Zod schema）、常量（错误码、状态枚举）、OpenAPI 类型 | **只读，双方都不写**，由主会话变更（PR 标 `[shared]`） |
| `infra/` | docker-compose、nginx、日志卷、备份脚本、健康检查 | **工程师 B** 主维护，**工程师 A** 在 PR 中 review 端口/域名 |
| `apps/web/prisma/` | `schema.prisma` / migrations / smoke test | **共享契约之一**，工程师 A/B **不直接改**；仅主会话迁移，变更走 ADR + review |
| `docs/` | ARCHITECTURE / IMPLEMENTATION_PLAN / DIAGRAMS / mockups / contracts / inputs / archive | 见各文档头部职责；旧模块图仅保留在 archive |

> **数据库治理约束**：工程师 A/B 不直接修改 schema 或 migration；修改必须开 `[db]` PR，并由主会话或指定的 schema 维护者 review。

## 先决条件

| 工具 | 用途 | 说明 |
|---|---|---|
| Node.js ≥ 20.11 | web (Next.js) | 已知可用版本 |
| pnpm ≥ 10 | monorepo | `corepack enable && corepack prepare pnpm@10.0.0 --activate` |
| uv | ai-engine (Python) | 已确认本机存在 |
| Python ≥ 3.11 | ai-engine runtime | 由 `packages/ai-engine/.python-version` 锁，uv 会自动切换 |
| Docker / docker compose | infra 部署 | Week 8 验收。本地 Preflight 使用 Homebrew PostgreSQL 16，AI engine 直接 `pnpm dev:ai` |

## 共享契约（不可被 A/B 私自改）

- **数据库 schema**：`apps/web/prisma/schema.prisma`，见 `docs/contracts/` 索引
- **API 错误码与状态码**：见 `docs/contracts/error-codes.md`
- **业务状态机**：见 `docs/contracts/state-machines.md`
- **环境变量与脚本名**：`docs/contracts/env-and-scripts.md`
- **类型与 enum**：`packages/shared/`
- **决策指标**：`docs/contracts/metrics.md`

任何工程师对以上契约的调整必须通过 PR + 在 ARCHITECTURE.md / IMPLEMENTATION_PLAN.md 同步版本号变更。

## 本地开发

```bash
# 安装依赖
pnpm install

# 启动 web + 数据库
pnpm db:migrate       # 仅主会话首次 Preflight 执行；A/B 不运行 migration
pnpm dev:web          # → http://localhost:3000

# AI engine（另一终端）
pnpm dev:ai           # → http://localhost:4000

# 自动化校验
pnpm typecheck
pnpm test
```

## 工程师 A/B 工作边界

### 工程师 A：Web / 产品流

负责 `apps/web/`、`packages/ui/`（未来），以及 Next.js / BFF / Auth / 权限 / 搜索 / Admin 控制台 UI / 详情页 / 评论组件等。可读但只读 `packages/shared/`、`apps/web/prisma/`、`docs/contracts/`。

**禁止**：
- 改 `packages/ai-engine/`
- 改 `infra/` 下的部署产物和 nginx 配置
- 改 `apps/web/prisma/`（除非走 ADR 并由主会话实施）
- 直接调用 OpenAI / Anthropic SDK（必须经过 `packages/ai-engine` 的 adapter）
- 跳过权限 helper 写"前端先显隐、服务端不校验"的逻辑

### 工程师 B：AI / 平台

负责 `packages/ai-engine/` 和明确授权的 `infra/`，以及 AI/import worker、adapter、数据抓取、导入转换、部署、日志和成本埋点。可读但只读 `apps/web/`、`packages/shared/`、`docs/contracts/`。

**禁止**：
- 改 `apps/web/` 的任何文件（防止两条业务路径重复写）
- 直接使用 next-auth 或 React 组件（Web 层负责）
- 跳过 `Job Worker + 任务状态端点` 把 AI 调用塞进 HTTP 请求
- 引入新第三方 LLM 服务不通知 A（共享配额 + 上下文注入规则要两边一致）

## 9 周开发节奏

详见 `docs/IMPLEMENTATION_PLAN.md`。每周交付记录模板在 `docs/IMPLEMENTATION_PLAN.md §十五`。

## 不进 P0 的功能（禁飞区）

详见 `docs/IMPLEMENTATION_PLAN.md §十四`。任何新增 P0 请求必须同时写明：替换掉哪一项、减少多少人周、是否改变 Week 13 指标。
