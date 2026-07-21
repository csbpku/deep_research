# packages/ai-engine

AI 调研引擎、Fetch/Compress/Write 轻量路径、SSRF-safe URL fetcher。
工程师 B：AI / 平台 独占领地。其他角色可读，不写。

## 模块边界

```
packages/ai-engine/
├── ai_engine/
│   ├── adapters/           # ResearchEngineAdapter（fake / claude / gpt-researcher）
│   ├── contracts/          # 镜像 packages/shared/src/{errors,states}.ts (ADR 0002 #8 关闭)
│   ├── fetcher/            # SSRF-safe URL fetcher（Week 4 交付）
│   ├── summary/            # 摘要轻量模式 reportType=summary_brief（Week 2）
│   ├── research/           # 五步调研流水线（Week 5）
│   ├── job_runner/         # InMemory store + run_once（Week 1）; DB store 在 Week 5
│   ├── server/             # FastAPI app — /healthz /api/ai/jobs (Week 1)
│   └── clients/            # Postgres / Tavily / arxiv-mcp / GitHub API（后续周）
├── tools/
│   └── spike.py            # Week 1 spike harness（fake / claude / gpt_researcher）
├── reports/                # spike 报告生成物（每次跑追加 spike-summary.md）
├── tests/
└── pyproject.toml
```

## 本地开发

```bash
# 1. 安装依赖
uv sync

# 2. 跑测试（fake adapter、job runner、HTTP 端点、spike harness）
uv run pytest

# 3. 启动 ai-engine 骨架（与根脚本 `pnpm dev:ai` 等价）
uv run uvicorn ai_engine.server.app:app --port 4000

# 4. 跑 Week 1 spike（默认 3 个中文主题 + fake adapter）
uv run python tools/spike.py --adapter fake
uv run python tools/spike.py --adapter claude          # Week 5 stub
uv run python tools/spike.py --adapter gpt_researcher  # Week 5 stub
```

## 端点(Week 1)

- `GET  /healthz` / `/health` — 适配器健康 + service 身份。
- `POST /api/ai/jobs` — 提交任务；Week 1 同步运行(返回 `final_status`),Week 5 改为异步 + 2 秒内返回 id。
- `GET  /api/ai/jobs/{id}` — 读取已持久化的快照。
- `POST /api/ai/jobs/{id}/cancel` — 取消 queued/running 任务。

## 共享契约(只读)

- `packages/shared/src/errors.ts` → TS 类型
- `apps/web/prisma/schema.prisma` → 数据库结构(只读;可 validate/generate,**不**迁移或手写 SQL)
- 错误码 / 状态机 / env 名见根 README 与 `docs/contracts/`

## Week 1 ADR 草案

主引擎选型 ADR 草案见 `docs/decisions/0004-ai-engine-selection.md`(由主会话在 PR
review 后落库,工程师 B 在 PR 摘要里给出草稿)。
