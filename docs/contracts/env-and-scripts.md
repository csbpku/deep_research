# 环境变量与脚本命名契约

> 环境变量命名、npm 脚本命名、docker compose 服务名的单一可信源。
> 修改跨服务变量时同步 `apps/web/.env.example` 与 `packages/ai-engine/.env.example`；服务专有变量只更新其消费方模板，Compose 运维变量更新根 `.env.example`。
>
> 设计原则：
> 1. **跨服务一致的变量名**——DATABASE_URL / *_DAILY 预算 等保持一致
> 2. **不同服务的本地变量不暴露**——TS 端不读 TAVILY_API_KEY（让 ai-engine 自己处理）
> 3. **不暴露密钥**——所有 `_*_KEY` / `_*_SECRET` 必须空在仓库，运行时通过 KMS / SOPS / secrets 注入

---

## 1. 跨服务约定（两个 .env 都用）

| 变量 | 类型 | 说明 |
|---|---|---|
| `DATABASE_URL` | postgresql URL | 两服务同源；Tavily pool 由 ai-engine 独占；web 走 Prisma client |
| `BUDGET_TEAM_DAILY` | int | 架构 §九 风险 4：团队 20 次/日；缺省 20 |
| `BUDGET_USER_DAILY` | int | 5 次/日；缺省 5 |
| `NODE_ENV` | enum: dev/prod/test | 仅 apps/web 用；ai-engine 不需要 |
| `LOG_LEVEL` | enum: debug/info/warn/error | 两服务一致 |

## 2. apps/web 专有（Next.js 进程）

| 变量 | 类型 | 说明 | 缺省 |
|---|---|---|---|
| `NEXTAUTH_URL` | URL | NextAuth base URL | `http://localhost:3000` |
| `NEXTAUTH_SECRET` | secret | NextAuth session 签名 | 必填 |
| `AI_ENGINE_URL` | URL | 仅 dev 模式下 web 直接调 ai-engine 用 | `http://localhost:4000` |
| `GOOGLE_CLIENT_ID` | oauth | Google OAuth client；`AUTH_GOOGLE_ONLY=1` 时必填 | 可选 |
| `GOOGLE_CLIENT_SECRET` | secret | Google OAuth secret；`AUTH_GOOGLE_ONLY=1` 时必填 | 可选 |
| `GITHUB_CLIENT_ID` | oauth | GitHub OAuth client；回调为 `{NEXTAUTH_URL}/api/auth/callback/github` | 可选 |
| `GITHUB_CLIENT_SECRET` | secret | GitHub OAuth secret | 可选 |
| `AUTH_GOOGLE_ONLY` | enum: 0/1 | 兼容旧部署；设为 `1` 时只注册 Google provider，关闭密码和 GitHub 登录 | `0` |
| `AUTH_BETA_MODE` | enum: 0/1 | 设为 `1` 时，新账号必须先由 Admin 按邮箱加入白名单；同时约束密码注册和 OAuth 首次开户 | `0` |
| `AUTH_EMAIL_VERIFICATION` | enum: 0/1 | 密码注册是否必须通过邮箱验证码；启用时必须配置 SMTP。为已存在无密码账号设置密码仅在启用时允许 | `0` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | SMTP | 验证邮件服务器连接配置 | host 必填，端口 `587` |
| `SMTP_USER` / `SMTP_PASSWORD` | secret | SMTP 认证；必须同时填写，也可同时留空使用可信中继 | 可选 |
| `SMTP_FROM` | email sender | 验证邮件发件人，如 `Research <noreply@example.com>` | 启用验证时必填 |
| `ALLOWED_EMAIL_DOMAINS` | csv | 旧邀请码激活接口的兼容 allowlist；不限制公开注册或 OAuth | 空 |
| `AUTH_INVITE_CODE` | secret | 旧 `/api/auth/activate` 的共享邀请码；正式页面使用公开注册 | 可选 |
| `MAX_UPLOAD_SIZE_MB` | int | 与 nginx 配合；web 层只校验形状 | `5` |
| `TIME_VALUE_USD_PER_HOUR` | positive number | Week 13 ROI 固定时薪；Week 9 冻结 | `50` |
| `BOOTSTRAP_ADMIN_EMAIL` | email | 首次启动时幂等创建/提升初始 Admin；默认 `shaobo.chen@shopee.com`，域名必须在 allowlist 内；`off`/`disabled` 可关闭 | `shaobo.chen@shopee.com` |
| `INTERNAL_SERVICE_TOKEN` | secret | Web BFF 调用 AI engine 管理接口的共享令牌；两服务必须完全一致 | 必填 |

**禁止**：
- Web 进程不得读 `TAVILY_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
- Web 进程不得读 `URL_FETCH_MAX_BYTES` 等 ai-engine fetcher 内部变量

Google OAuth callback 为 `{NEXTAUTH_URL}/api/auth/callback/google`，GitHub OAuth callback 为 `{NEXTAUTH_URL}/api/auth/callback/github`，必须在各 provider 控制台登记完全相同的 URI。未配置的 OAuth provider 不注册；`AUTH_GOOGLE_ONLY=1` 时 Google 凭证必须存在，并且只注册 Google provider。非 Google-only 模式默认支持公开邮箱密码注册；`AUTH_BETA_MODE=1` 时改为 Admin 邮箱白名单准入，并同步限制 OAuth 首次开户及旧激活接口。`ALLOWED_EMAIL_DOMAINS` 与 `AUTH_INVITE_CODE` 只影响旧 `/api/auth/activate` 兼容接口的额外校验。

## 3. packages/ai-engine 专有

| 变量 | 类型 | 说明 | 缺省 |
|---|---|---|---|
| `TAVILY_API_KEY` | secret | 外部搜索凭证；仅当 `RETRIEVER=tavily` 时必填，`duckduckgo` 不需要 | 条件必填 |
| `RESEARCH_LLM` | `provider:model` | 完整 AI 调研主模型；gpt-researcher 兼容槽由它派生 | `minimax:MiniMax-M3.1-Flash` |
| `UTILITY_LLM` | `provider:model` | 评分、摘要、审核、聊天等工具型任务主模型 | `minimax:MiniMax-M3.1-Flash` |
| `FALLBACK_LLM` | `provider:model` | 所有共享调用的独立备用模型 | `deepseek:deepseek-v4-flash` |
| `SMART_LLM` / `FAST_LLM` / `STRATEGIC_LLM` / `BRIEF_LLM` | `provider:model` | 仅供 gpt-researcher 兼容的 legacy mirror，不作为业务路由真源 | 由 canonical 路由派生 |
| `ANTHROPIC_API_KEY` | secret | Anthropic 兼容 provider 的轻量任务凭证 | 按 provider 必填 |
| `ANTHROPIC_BASE_URL` | url | DeepSeek / Anthropic / cc-switch 等兼容端点 | 可选 |
| `ANTHROPIC_API_KEY_HEAVY` | secret | 重量级任务凭证 (Shopee compass gateway);缺省回退 `ANTHROPIC_API_KEY` | 可选 |
| `ANTHROPIC_BASE_URL_HEAVY` | url | 重量级任务 API base;缺省回退 `ANTHROPIC_BASE_URL` | 可选 |
| `OPENAI_API_KEY` | secret | OpenAI 兼容 provider 的轻量任务凭证 | 按 provider 必填 |
| `OPENAI_BASE_URL` | url | OpenAI / vibeproxy 等兼容端点 | 可选 |
| `OPENAI_API_KEY_HEAVY` | secret | OpenAI 兼容 provider 的重量任务凭证;缺省回退 `OPENAI_API_KEY` | 可选 |
| `OPENAI_BASE_URL_HEAVY` | url | OpenAI 兼容重量任务 API base;缺省回退 `OPENAI_BASE_URL` | 可选 |
| `MINIMAX_API_KEY` | secret | MiniMax 模型专用直连凭证；匹配 `MiniMax-*` | 可选 |
| `MINIMAX_BASE_URL` | url | MiniMax 模型专用直连 API base | `https://api.minimaxi.com/v1` |
| `DEEPSEEK_API_KEY` | secret | DeepSeek 模型专用直连凭证；匹配 `deepseek-*` | 可选 |
| `DEEPSEEK_BASE_URL` | url | DeepSeek 模型专用直连 API base | `https://api.deepseek.com/v1` |
| `AI_ENGINE_ADAPTER` | str | `gpt_researcher` (默认) 或 `fake` | `gpt_researcher` |
| `SCORING_PROFILE` | enum: paper/engineering/news | 蒸馏评分受众画像（Distilled v2）；沿用 `tech_blog` 自动映射 `engineering` | `engineering` |
| `RADAR_DEEPDIVE_ENABLED` | bool | sync 是否抓 originalMarkdown 入摘要（Week 9 feature flag） | `true` |
| `GH_TOKEN` | secret | GitHub API 配额提升 | 可选 |
| `WORKER_LEASE_SECONDS` | int | 任务抢锁租约（崩溃恢复窗口）。AI research job 的有效租约 = `max(此值, DEEP_RESEARCH_TIMEOUT_SECONDS + 120)`，默认即 1320s（须覆盖深度 job 预算并留出 120s 收尾缓冲） | 代码默认 `180`（job_runner；分享/雷达提交 worker 未设置时为 `1020`）；`infra/docker-compose.yml` / `.env.example` 为 `60` |
| `WORKER_HEARTBEAT_SECONDS` | int | 心跳间隔 | `15` |
| `AI_JOB_MAX_CONCURRENCY` | int | 单进程同时运行的 AI 调研任务上限（POST 直接触发与 worker 循环共用），超出排队 | `2` |
| `ADAPTER_JOB_TTL_SECONDS` | int | adapter 内存中已结束任务的保留秒数 | `3600` |
| `ADAPTER_JOB_MAX_RETAINED` | int | adapter 内存中最多保留的已结束任务数 | `200` |
| `TRUSTED_PROXY_HOPS` | int | Web 取客户端 IP 时信任的反代层数；默认忽略 `X-Forwarded-For`，只用 nginx 设置的 `x-real-ip` | `0` |
| `RENDER_REVIEW_TOKEN` | secret | render-review sidecar 的共享令牌（请求头 `x-render-review-token`）；缺失则 sidecar 拒绝启动，默认复用 `INTERNAL_SERVICE_TOKEN` | 同 `INTERNAL_SERVICE_TOKEN` |
| `RENDER_REVIEW_ALLOWED_BASE_URLS` | list | sidecar 允许打开的 baseUrl 来源白名单 | `http://web:3000` |
| `WORKER_MAX_RETRIES` | int | attempts 上限；有效值被 clamp 到 `0–3`（DB CHECK 约束 `attempts` ≤ 3，超过会使 reaper 的 requeue UPDATE 失败；`DbJobStore` 对超限值记 warning 并按 3 处理） | `3`（有效最大值也是 `3`） |
| `DEEP_RESEARCH_TIMEOUT_SECONDS` | int | deep job 总预算；覆盖普通 worker 超时，需包含检索、写作和事实审核 | `1200`（代码与 compose 一致） |
| `DEEP_RESEARCH_COLLECTION_TIMEOUT_SECONDS` | int | deep job 检索/证据树预算；到达后使用已有证据进入写作 | `900` |
| `DEEP_REPORT_WRITE_TIMEOUT_SECONDS` | int | deep 研究稿写作阶段独立超时 | `180` |
| `FACT_REVIEW_TIMEOUT_SECONDS` | int | 独立事实审核单次尝试超时，范围 30–600 秒 | `180` |
| `URL_FETCH_MAX_BYTES` | int | 单次抓取大小上限（字节） | `2097152`（2MB） |
| `URL_FETCH_TIMEOUT_SECONDS` | int | 单次抓取超时 | `10` |
| `URL_FETCH_MAX_REDIRECTS` | int | 最大重定向次数 | `3` |
| `WORKER_REAPER_INTERVAL_SECONDS` | int | reaper 周期 | `30` |
| `DB_POOL_MIN_SIZE` | int | ai-engine PostgreSQL 连接池最小连接数 | `2` |
| `DB_POOL_MAX_SIZE` | int | ai-engine PostgreSQL 连接池最大连接数 | `10` |
| `RADAR_SOURCE_CONCURRENCY` | int | 同时运行的雷达来源数 | `5` |
| `RADAR_CANDIDATE_CONCURRENCY` | int | 单来源同时处理的候选数 | `3` |
| `RADAR_FETCH_RETRIES` | int | 来源与候选传输失败后的额外重试次数 | `2` |
| `RADAR_FETCH_RETRY_BACKOFF_SECONDS` | float | 传输重试的初始退避秒数（指数增长） | `0.5` |
| `RADAR_LLM_CONCURRENCY` | int | 全局 LLM 调用上限，sync/enrichment 共用 | `8` |
| `RADAR_SCORING_CONCURRENCY` | int | Distilled 评分额外上限 | `8` |
| `RADAR_ENRICHMENT_CONCURRENCY` | int | Stage 2 enrichment 候选并发数 | `2` |
| `RADAR_ENRICHMENT_ITEM_TIMEOUT_SECONDS` | float | enrichment 单条外层超时；`0` 交给 durable worker/Zread CLI 自己控制，正数仅用于显式有界修复 | `0` |
| `RADAR_RUN_LEASE_SECONDS` | int | 来源级 run 租约；候选完成续期，过期行由 cron/Admin 入口回收 | `900` |
| `RADAR_GOVERNANCE_STATE_DIR` | path | Admin 治理备份校验和批次目录；独立 repair Compose 将它设为 `RADAR_REPAIR_DIR`，不能指向未验证的备份 | `/data/zread/governance` |
| `RADAR_REPAIR_DELETE_CONFIRMED_NOISE` | enum: 0/1 | 持久补分/摘要 worker 的物理删除开关；设为 `1` 前须有明确生产删除授权，逐条检查当前有效噪声评分和引用保护，不要求重抓完整原文 | `0` |
| `RADAR_GITHUB_ENRICHMENT_RETRY_SECONDS` | int | GitHub/Zread 失败后的重试退避；Admin 强制刷新可绕过延迟 | `7200` |
| `RADAR_RENDER_REVIEW_ENABLED` | bool | 是否运行可选的 Chromium 页面审核；生产 registry 默认强制关闭，正文质量和内容审核不受影响 | `0`（生产） |
| `RADAR_RENDER_REVIEW_BASE_URL` | URL | 渲染审核打开的 Web 基地址 | `http://127.0.0.1:3000` |
| `RADAR_RENDER_REVIEW_INTERVAL_SECONDS` | int | 渲染审核 worker 轮询间隔 | `30` |
| `RADAR_RENDER_REVIEW_BATCH_SIZE` | int | 每轮最多领取的渲染审核条数 | `1` |
| `RADAR_RENDER_REVIEW_TIMEOUT_SECONDS` | int | 单条桌面/移动浏览器审核超时 | `150` |
| `RADAR_RENDER_REVIEW_STALE_MINUTES` | int | reviewing 状态回收阈值 | `30` |
| `RADAR_SOURCE_RETRIES` | int | 每日 cron 补偿：仅重试 failed/partial 来源的额外次数 | `2` |
| `RADAR_SOURCE_RETRY_BACKOFF_SECONDS` | float | 来源重试初始退避秒数 | `10` |
| `RADAR_CONTENT_RETRIES` | int | HTTP 200 但正文抽取为空/被拦截时的重试次数 | `1` |
| `RADAR_CONTENT_RETRY_BACKOFF_SECONDS` | float | 正文重试退避秒数 | `1` |
| `RADAR_RATE_LIMIT_RETRY_BACKOFF_SECONDS` | int | 上游限流后的退避秒数 | `60` |
| `RADAR_ENRICHMENT_RETRIES` | int | enrichment 阶段失败补偿重试次数 | `2` |
| `RADAR_SYNC_CRON_ENABLED` | bool | 是否启用每日全量同步 cron（锚定分层循环） | `1` |
| `RADAR_SYNC_CRON_TIME` | time | 每日全量扫描时刻；来源节奏见 `ai_engine/server/app.py` 的 tier 表 | `02:00` |
| `TOPIC_PROPOSAL_ENABLED` | bool | 同步后生成 review-only 专题提案；Admin 审批后才生效 | `1` |
| `TOPIC_PROPOSAL_CRON_TIME` | time | 专题提案 cron 时刻 | `09:00` |
| `TOPIC_PRESETS_JSON` | json | 预置专题定义（可选） | 空 |
| `ZREAD_REMOTE_ENABLED` | bool | 先尝试公共 Zread 远程页生成 GitHub wiki 缓存 | `1` |
| `ZREAD_CLI_ENABLED` | bool | 远程无已发布目录时回退本地 zread CLI | `1` |
| `ZREAD_CLI_BIN` | str | 本地 zread CLI 可执行名 | `zread` |
| `ZREAD_CLI_TIMEOUT_SECONDS` | int | CLI 目录+页面生成超时；0=不限时，中断保留已生成的部分页 | `7200` |
| `GBRAIN_MCP_URL` | url | 只读 GBrain HTTP MCP sidecar 端点（可选） | 空 |
| `GBRAIN_MCP_TOKEN` | secret | GBrain sidecar 鉴权 token（可选） | 空 |
| `ANYTHINGLLM_URL` | url | AnythingLLM 可选端点：AI 调研助手集成及遗留雷达 AI 会话 API；雷达页面当前未挂载该聊天面板 | 空 |
| `ANYTHINGLLM_API_KEY` | secret | AnythingLLM API key（可选） | 空 |
| `ANYTHINGLLM_WORKSPACE` | str | AnythingLLM workspace slug（可选） | 空 |
| `ANYTHINGLLM_ENABLED` | bool | 是否启用 AnythingLLM 集成 | `true` |
| `ANYTHINGLLM_RADAR_IDS` | csv | 遗留雷达 AI 会话 API 的 ID 限制；空=所有雷达候选可作为会话种子；当前无对应页面入口 | 空 |
| `ANYTHINGLLM_PERSONAL_KNOWLEDGE_ENABLED` | enum: 0/1 | 独立个人知识向量索引总开关；按用户隔离 workspace，不复用共享雷达/聊天 workspace。固定镜像的隔离账号入库、检索、编辑、删除闭环和资源核验完成前必须保持关闭 | `0` |
| `KNOWLEDGE_INDEX_WORKER_POLL_SECONDS` | float | 个人知识索引 outbox worker 空队列轮询间隔 | `2` |
| `KNOWLEDGE_INDEX_LEASE_SECONDS` | int | 个人知识索引 outbox 任务租约；小于 `60` 会按 `60` 处理 | `300` |
| `WEWE_AUTH_CODE` | secret | WeWe RSS 控制台授权码；自动 feed.refreshArticles 必需 | 空 |
| `PRODUCTHUNT_API_TOKEN` | secret | ProductHunt GraphQL token；留空禁用该来源 | 空 |
| `RETRIEVER` | enum: tavily/duckduckgo | AI 调研检索后端；仅 tavily 需要 `TAVILY_API_KEY` | `tavily` |
| `LLM_USAGE_AUDIT_ENABLED` | bool | 共享 LLM 调用 usage 审计记录开关 | `true` |
| `LLM_RETRY_ATTEMPTS` | int | 主模型同规格重试次数 | `1` |
| `LLM_CIRCUIT_ENABLED` | bool | endpoint 连续失败熔断开关 | `true` |
| `LLM_CIRCUIT_FAILURE_THRESHOLD` | int | 连续连接/5xx 触发熔断的阈值 | `3` |
| `LLM_CIRCUIT_COOLDOWN_SECONDS` | int | 熔断冷却秒数；随后半开探测 | `45` |
| `LLM_RECOVERY_ENABLED` | bool | 临时故障后的 score/enrichment 补跑 worker 开关 | `1` |
| `LLM_RECOVERY_INTERVAL_SECONDS` | int | recovery worker 轮询间隔；启动立即执行一轮，后续默认每 10 分钟检查 retryable 队列 | `600` |
| `LLM_RECOVERY_LIMIT` | int | 单轮 recovery 最多处理条数 | `50` |
| `EVIDENCE_RECONCILIATION_ENABLED` | bool | 声明级补证完成后，后台合并来源并排入新事实审核 | `1` |
| `EVIDENCE_RECONCILIATION_INTERVAL_SECONDS` | float | 补证任务后台接管轮询间隔；浏览器关闭不影响状态收敛 | `2` |
| `INTERNAL_SERVICE_TOKEN` | secret | 校验 Web 发起的同步、主题聚合与综述管理，以及个人知识语义候选检索请求 | 必填 |

### 独立雷达治理 Compose

`infra/docker-compose.radar-repair.yml` 单独读取根 `.env` 的 `RADAR_REPAIR_DIR`（已验证备份根目录）、`RADAR_REPAIR_ACTOR`（真实 Admin 邮箱或 ID）和不可变 `AI_ENGINE_IMAGE`；启用时三者必填。断点、调用预留和删除归档保存在 `RADAR_REPAIR_DIR/repair`。它们不由 Web 消费，也不自动启动治理。部署跟随标记、调用与重试上限、恢复和审计见 [雷达治理契约](./radar-governance.md#continuous-repair-and-confirmed-noise-deletion)。

## 4. 命名规则

- 全大写下划线分隔（PostgreSQL / Docker convention）
- 时间量必须带完整单位后缀（如 `_SECONDS`，不用含糊的 `_S`）
- 对确实“必须给值才允许启动”的变量，在 docker-compose 里用
  `${VAR:?set in .env}` 强校验；条件变量（如仅 `RETRIEVER=tavily` 时需要的
  `TAVILY_API_KEY`）不得无条件阻断 `duckduckgo` 配置

## 5. npm / pnpm 脚本

### 根 package.json（必须）

| 脚本 | 等效命令 | 用途 |
|---|---|---|
| `db:deploy` | `pnpm --filter @deep-research/web db:deploy` | Prisma migrate deploy（setup / 部署用） |
| `db:migrate` | `pnpm --filter @deep-research/web db:migrate` | Prisma migrate dev |
| `db:generate` | `pnpm --filter @deep-research/web db:generate` | Prisma generate |
| `db:reset` | `pnpm --filter @deep-research/web db:reset` | Prisma reset |
| `dev:web` | `pnpm --filter @deep-research/web dev` | 启 web |
| `dev:ai` | `cd packages/ai-engine && UV_CACHE_DIR=${UV_CACHE_DIR:-/tmp/deep-research-uv-cache} uv run uvicorn ai_engine.server.app:app --host 127.0.0.1 --port 4000 --reload --reload-dir ai_engine` | 启 ai-engine |
| `ingest:summaries` | 从 AI engine 执行一次 RSS/arxiv 摘要摄取 | cron / 运维手工触发 |
| `worker:imports` | 领取并执行一个文件导入任务，同时清理 24h 遗留文件 | worker / 运维验证 |
| `build` | `pnpm -r build` | 全 monorepo build |
| `typecheck` | `pnpm -r typecheck` | 全 typecheck |
| `lint` | `pnpm -r lint` | 全 lint |
| `test` | `pnpm -r test` | 全测试 |

### apps/web 内部（不允许重复命名）

`web` 内部脚本 **必须** 带前缀 `dev:` / `db:` / `lint:` 等公共命名空间，
避免根脚本与包内脚本同名。

| 脚本 | 等效命令 |
|---|---|
| `dev` | `next dev -p 3000` |
| `build` | `next build` |
| `start` | `next start -p 3000` |
| `lint` | `next lint` |
| `typecheck` | `tsc --noEmit` |
| `test` | `vitest run` |
| `db:deploy` | `prisma migrate deploy` |
| `db:migrate` | `prisma migrate dev` |

### packages/shared 内部

| 脚本 | 等效命令 |
|---|---|
| `typecheck` | `tsc --noEmit` |
| `test` | `vitest run` |

### 禁止项

- 已在 db11bf3 删除：`worker:run` / `worker:lease-recover`（引用不存在的文件）
- 不允许 `*:*:run` 多级命名（违反"必须带公共前缀"规则）

## 6. docker compose 服务名

> `infra/docker-compose.yml` 当前锁定。

| 服务 | 容器名 | 端口 | 卷 |
|---|---|---|---|
| `postgres` | `deep-research-postgres-1` | 5432 | `postgres-data` |
| `web` | `deep-research-web-1` | 3000 | `import-tmp` |
| `ai-engine` | `deep-research-ai-engine-1` | 4000 | — |
| `nginx` | `deep-research-nginx-1` | 80/443 | 配置文件 bind mount |

**服务名必须在所有引用处一致**：
- apps/web/.env `DATABASE_URL` 用 `postgres:5432`
- packages/ai-engine/.env `DATABASE_URL` 用 `postgres:5432`
- infra/nginx.conf `upstream` 用 `web:3000` / `ai-engine:4000`

**禁止**：
- 用 `localhost`（容器间走服务名）
- 用 IP（容器重启 IP 变）

## 7. 校验与运行时保护

- 启动前：`dotenv -e .env -- pnpm typecheck` 可作为 pre-commit 钩子（Week 2 加）
- compose 内：用 `${VAR:?set in .env}` 让缺关键变量启动失败
- Web 层：`apps/web/src/lib/env.ts` 用 Zod 解析 env；启动期失败立即报错
  （Week 1 加，本档案作为 schema）

## 8. 自检清单

新加 env 变量前：

- [ ] 命名符合本档 §4
- [ ] 已加到对应 `.env.example`
- [ ] 必填变量已在 compose 用 `${VAR:?...}` 校验
- [ ] 敏感值未写入仓库
- [ ] Python / TS 端同时更新（若是跨服务变量）

## 9. LLM 分层策略

按调用频率与质量需求拆两层；`_run_brief`、蒸馏评分、AI 追问都属轻量任务,
gpt-researcher 完整流水线属重量级任务。

| 任务 | LLM 变量 | 凭证变量 |
|---|---|---|
| radar 候选 brief 摘要 (`_run_brief`) | `UTILITY_LLM` | provider 对应 light 凭证 |
| radar 蒸馏评分 (`anthropic_scorer`) | `UTILITY_LLM` | provider 对应 light 凭证 |
| AI 追问 (`summary_brief`) | `UTILITY_LLM` | provider 对应 light 凭证 |
| gpt-researcher 完整流水线 | `RESEARCH_LLM` | provider 对应 heavy 凭证 |

**向后兼容**：当 `ANTHROPIC_API_KEY_HEAVY` / `ANTHROPIC_BASE_URL_HEAVY` 未设置时,重层
自动使用 light 凭证,所有任务走同一网关,行为与单 key 部署一致。dev/CI 无需配置
compass gateway 即可运行。

**fallback 顺序**：
- 主模型：同模型重试 1 次 → `FALLBACK_LLM` → fallback 重试 1 次
- endpoint 连续 3 次连接/5xx 后熔断 45 秒，冷却后半开探测
- 业务确定性降级（规则/原文/默认分数）不再调用模型，并记录 `status=degraded`
- `ANTHROPIC_API_KEY_HEAVY` → `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL_HEAVY` → `ANTHROPIC_BASE_URL`
- `OPENAI_API_KEY_HEAVY` → `OPENAI_API_KEY`
- `OPENAI_BASE_URL_HEAVY` → `OPENAI_BASE_URL`

`RESEARCH_LLM` / `UTILITY_LLM` / `FALLBACK_LLM` accept
`minimax:<model>`, `deepseek:<model>`, `anthropic:<model>` and `openai:<model>`.
The selected vendor reads
the matching credential pair:

- `minimax:*` → `MINIMAX_API_KEY` / `MINIMAX_BASE_URL`
- `deepseek:*` → `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`
- `anthropic:*` → `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`
- `openai:*` → `OPENAI_API_KEY` / `OPENAI_BASE_URL`
- heavy calls first try the corresponding `*_HEAVY` pair, then fall back
  to the light pair.

Deployment presets:

- Local cc-switch: `anthropic:*`, base URL `http://localhost:15721`
- Local vibeproxy: `openai:*`, base URL `http://localhost:8318/v1`
- VPS default: DeepSeek Anthropic-compatible API at
  `https://api.deepseek.com/anthropic`

现役雷达任务生命周期为：`sync → enrich → topic refresh`。

- 日报生成链路已于 2026-08-11 整体删除；GitHub tracked/activity 抓取与
  tracked-repo postprocess 已于 2026-08-26 收口移除。
- GitHub repo 候选统一走 Distilled tier 评分 + Zread 文档缓存；
  详情页提供统一的“刷新文档”入口，强制重取 Zread，失败保留旧缓存。
- 运行证据与迁移状态以 `docs/PROJECT_STATUS.md` 最新条目为准。
