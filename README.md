# 技术调研平台

个人深度研究 / 技术调研平台。AI 调研 + 技术雷达 + 每日摘要 + 沉淀 + Admin 审核闭环。

[![CI](https://github.com/csbpku/deep_research/actions/workflows/ci.yml/badge.svg)](https://github.com/csbpku/deep_research/actions/workflows/ci.yml)

> 状态入口：[`docs/PROJECT_STATUS.md`](./docs/PROJECT_STATUS.md)（测试指标、follow-up、文档地图）
> 架构基线：[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) v3.6
> 实施计划：[`docs/IMPLEMENTATION_PLAN.md`](./docs/IMPLEMENTATION_PLAN.md) v1.3（9 周开发 + 4 周试用）

## 当前状态（2026-07-30 · Week 9 收尾后进入试用冻结期）

- Week 7–9 ✅（gpt-researcher 主适配、评论 / Admin / 部署脚手架、回归 + 安全 + 文档基线）
- 测试：253 Web 单测 / 270 + 1 skipped Python 单测 / 21 + 2 skipped Web E2E / 11 + 2 skipped Python E2E
- 进入 Week 10–13 试用，不新增 P0，仅修 S0/S1

## 快速开始

```bash
./scripts/setup.sh          # 默认（交互）
./scripts/setup.sh --quick  # 只想看 UI：不需要任何 API key
```

完成后两个终端：`pnpm dev:web`（:3000）+ `pnpm dev:ai`（:4000）。详细步骤、API key、踩坑 → [wiki/Getting Started](./docs/wiki/getting-started.md)。

## Wiki

新人、运维、试用管理员从下面入口读：

| 页面 | 何时打开 |
|---|---|
| [Getting Started](./docs/wiki/getting-started.md) | 第一次 clone |
| [Development Guide](./docs/wiki/development.md) | 改代码、PR、契约、ADR |
| [Deployment & Ops](./docs/wiki/deployment.md) | `infra/`、Docker Compose、备份/恢复、TLS |
| [Operations Runbook](./docs/wiki/operations.md) | 试用冻结期、监控、备份节奏、Go/No-Go 数据 |

详细目录见 [docs/wiki/README.md](./docs/wiki/README.md)。

## 仓库布局

| 路径 | 角色 |
|---|---|
| `apps/web/` | Next.js 15 Web + BFF + Prisma（工程师 A 拥有） |
| `packages/ai-engine/` | FastAPI + gpt-researcher 适配 + radar / import worker（工程师 B） |
| `packages/shared/` | Zod schema / 错误码 / 状态枚举（A/B 只读，改走 `[shared]` PR） |
| `infra/` | docker-compose / nginx / Dockerfile / 备份脚本 |
| `docs/contracts/` | API / 状态 / 错误 / 环境变量 / metric / URL 安全契约 |
| `docs/decisions/` | ADR（架构决策记录） |
| `docs/wiki/` | 本 README 的扩展版 |

详细分工与契约列表 → [wiki/Development Guide](./docs/wiki/development.md)。

## 工程师工作边界（一句话版）

工程师 A 不能动 `packages/ai-engine/` 和 `infra/`；工程师 B 不能动 `apps/web/`。双方都不直接改 `packages/shared/`、`apps/web/prisma/`、`docs/contracts/`——改这些走 PR + ADR。完整版见 [wiki/Development Guide §工程师分工](./docs/wiki/development.md#2-工程师分工边界)。
