# 技术方案总览

> 当前现役技术方案的唯一摘要。更新日期：2026-09-28。
> 真实部署、测试和线上运行证据仍按日期记录在 [`PROJECT_STATUS.md`](./PROJECT_STATUS.md)；
> 本文不记录开发过程流水账。

## 1. 项目边界

Deep Research 是面向个人和小团队的技术调研平台，负责：

- 从 GitHub、arXiv、RSS、厂商更新和社区来源发现技术候选；
- 对候选做正文抽取、AI 解读、Distilled 评分和阅读等级分层；
- 按专题聚合候选，生成热点议题和带引用的专题综述；
- 支持 AI 调研、研究稿、快速判断、Slides 提纲、网页简报和知识卡片；
- 提供独立 Chrome MV3 原网页阅读助手：在公开技术网页中按需全文翻译（含图片文字覆盖）、选段解读、连续追问、续读和本地收藏；雷达与研究库同步是可选连接；
- 支持登录、收藏、批注、评论、分享、全文搜索和 Admin 治理。
- 私人知识草稿可在 AI 调研“已有资料（可选）”中按关键词或语义找回；语义索引只接收用户确认的笔记/判断，不收 Reader 摘录或完整报告。

当前不追求高可用多机部署或异地数据库自动切换。生产目标是单 VPS、受控账号、可恢复后台任务和可验证的内容质量；注册策略需在生产设置 `AUTH_BETA_MODE=1` 才会关闭公开注册，代码默认 `0` 并不符合仅白名单开放的目标。

## 2. 运行拓扑

| 部件 | 责任 | 本地原生 | Docker / VPS |
|---|---|---|---|
| `apps/web` | Next.js 页面、BFF、NextAuth、Prisma | `3000` | `web:3000` |
| `packages/ai-engine` | FastAPI、LLM、雷达和后台 worker | `4000` | `ai-engine:4000` |
| PostgreSQL | 业务数据、队列、全文索引 | `5432` | `postgres:5432` |
| nginx | 公网反代、上传限制、健康路由 | 可选 | `80/443` |
| `apps/extension` | 独立 Chrome 侧栏、正文/图片处理、会话与收藏 | 加载解压目录 | Chrome 116+ |
| AnythingLLM | 内网 AI 讨论与隔离的个人语义索引 | 可选独立服务 | Compose 内网服务；宿主只绑定 loopback |

默认生产 Compose 运行 PostgreSQL、Web、AI engine、AnythingLLM 和 nginx。AnythingLLM 的 UI/API 只绑定 VPS loopback；Chromium `render-review` 是可选 profile，不属于默认生产资源预算。
个人知识索引使用独立于旧共享讨论 workspace 的 per-user workspace，`ANYTHINGLLM_PERSONAL_KNOWLEDGE_ENABLED` 默认关闭。

## 3. 核心数据流

### 雷达

```text
source sync
  -> transient original-source fetch (prefer full text; source snippet fallback)
  -> utility LLM brief + distilled score from the fetched text
  -> persist brief, score, URL and bounded source metadata; never persist full source text
  -> external reading entry (browser mode, default)
  -> topic workers retain their full-enrichment and review gates

legacy enriched mode (explicit opt-in only)
  candidate persistence -> 正文抓取 / enrichment -> reader quality -> content review
```

浏览器模式仍会在同步期间尽量抓取来源原文，供摘要和评分使用；全文只在处理期间暂存，不写入 summaries 或诊断正文，也不启动后续正文 enrichment。抓取失败或只拿到短内容时才回退到来源摘要，并在评分依据中标明。用户阅读、翻译和保存由原文/Reader 完成。显式启用 legacy enriched mode 时才持久化站内阅读正文并执行后续质量与内容审核。网络失败、正文不完整、评分缺失、内容审核未完成和主题聚类失败不能互相伪装成成功。

评分和摘要对较长正文按章节/段落及离线保守 token 估算分块（默认每块约 6,000 token-equivalent），逐块提取证据/要点，再聚合全文结论；评分引用会对照当次抓取的原文校验。模型没有 tokenizer 可用时使用偏保守的混合文本估算，仍受来源抓取响应大小上限约束。分块正文不持久化。

### Enrichment 与审核

- `distilledTargetTier` 保存评分得到的目标层级；`distilledTier` 表示雷达展示层级。传统服务端阅读模式下，目标为 `collection/deep_read` 但 enrichment 未完成时，实际层级为 `skim`；带 `external_reading` 标记的候选通过原文 URL/Reader 阅读，不要求服务端 enrichment，可保留评分层级。数据库 trigger 区分两种阅读路径，详情接口仍不返回外部阅读候选的缓存原文。
- `enrichmentStatus` 表示来源正文资产是否完成；
- `readerQualityStatus` 表示正文是否满足阅读质量门槛；
- `contentReviewStatus` 表示当前正文内容审核结果；
- `renderReviewStatus` 只属于可选 Chromium 页面审核，不是默认交付门槛。

当前默认审核路径是“正文质量检查 + 内容审核 + 可恢复 reconciliation”。历史 Chromium `unavailable` 不能代表当前内容审核失败；关闭 browser-review 时不会启动 Chromium，也不会重新创建 render 队列。

### AI 调研

Web 先创建可追踪任务，AI engine 通过 durable job store 异步执行研究、草拟、来源绑定、事实核验和产物入库。HTTP 请求只负责提交、查询和取消，不在请求线程内等待完整研究。

研究助手对长草稿的改写、摘要和反方观点按全文分块处理；事实核验的声明抽取也覆盖完整报告。Reader 选择“整页”问答/解释时，正文按章节/段落和离线 token 估算分块、逐块分析并汇总；单块或汇总失败会明确失败，不返回伪装成全文结论的部分结果。默认每块约 6,000 token-equivalent，可分别用 `RESEARCH_ASSISTANT_CHUNK_TOKENS`、`RESEARCH_REVIEW_CHUNK_TOKENS` 和 `READER_ANSWER_CHUNK_TOKENS` 调整。分块正文仅在请求处理中使用，不持久化。

### 研究库与个人语义索引

PostgreSQL `Research` 是研究库权威数据源；AnythingLLM 只提供可选的个人知识语义候选，不另建个人聊天入口，也不复用旧共享雷达/讨论 workspace。

- Reader 在平台模式下保存为本人私人草稿；原文摘录与锚点保留为来源，不进入向量文本。索引只含本人笔记和确认过的 AI 结论。AI 调研稿自动入研究库、不复制整份报告；用户选中一条回答或报告判断并确认后，才另存为私人知识草稿。
- 知识索引文本与持久 outbox 操作在同一数据库事务提交。outbox 不设 Research 外键，以便硬删除后保留清理墓碑；worker 从数据库读取当前有效草稿和来源引用，再执行 upsert/delete，失败时退避重试。编辑会生成新一代任务；发布、归档和硬删除会排队移除向量文档。
- 每位用户使用独立的 `dr-private-<user UUID>` workspace。AnythingLLM 检索 API 只返回记录 UUID；Web BFF 按当前用户、`knowledge` 类型和 `draft` 状态回查数据库最新版本，不信任向量返回的文本。候选在“已有资料”中默认不勾选，用户确认后才写入调研 `sourceRefs`；AnythingLLM 关闭、超时或索引滞后时保留关键词结果。AI engine 还会重新校验调研来源权限。
- `ANYTHINGLLM_PERSONAL_KNOWLEDGE_ENABLED` 默认 `0`，生产仍关闭。2026-09-28 本机隔离测试已由用户报告真实 AnythingLLM worker 入库、向量检索、替换和删除通过；Web → AI Engine → AnythingLLM 浏览器跨层验收仍待执行。旧共享讨论 workspace 不复用，历史已发布知识卡片不批量导入。具体验证与部署状态见 [`PROJECT_STATUS.md`](./PROJECT_STATUS.md)。

### 原网页阅读

独立 Beta 在用户点击扩展按钮后通过 `activeTab` / `scripting` 注入当前页，提取正文块、选段和正文图片；侧栏直接调用用户配置的 OpenAI-compatible `/chat/completions` 或 Anthropic-compatible `/messages` 接口，不加载 Web iframe、不要求平台账号、不把 API Key 放进网页。正文按块翻译，图片通过视觉模型返回文字区域与坐标，并在原图上生成可移除的译文覆盖层；Anthropic 图片请求在扩展边界转换为 base64，跨域图片无法读取时保留 URL并显示处理失败。正文、图片和页面内容始终按不可信资料处理，排除表单、密码和 `contenteditable`。

侧栏的阅读会话、滚动位置、选段、讨论和收藏存储在 IndexedDB；全文翻译结果只作为有界缓存，API Key 不进入导出数据。选择整页问答/解释时，平台模式把完整提取正文送入服务端分块分析并汇总；选择选段/章节时则按明确范围处理。当前发布构建使用 WXT + React + TypeScript，生产目录为 `apps/extension/.output/chrome-mv3`。React 负责完整侧栏 UI 树，独立的控制器保留为 content-script、MV3 worker、IndexedDB 和可选平台连接之间的消息边界；这不会把页面状态或模型密钥放回网页。模型供应商能力探测已在设置连接时执行，商店发布仍按范围暂缓。

平台连接是可选层：连接后才调用 `/api/reading/answer`、`/api/reading/answer/stream`、`/api/reading/translate` 和 `/api/reading/save`，将用户确认的成果同步到研究库；平台不可用时，独立翻译、图片处理、讨论和本地收藏仍可用。研究库同步继续保留数据库幂等键和安全锚点校验。雷达的新外部原文入口不依赖 enrichment；`RADAR_READING_MODE=browser` 只停止全文持久化和后续 enrichment，不停止同步期间的临时全文抓取与评分。

Reader 与 Monica 原网页交互的对照、技术阅读差异化、双模式权威数据边界和明确非目标见 [`READER_PRODUCT_DECISIONS.md`](./READER_PRODUCT_DECISIONS.md)。

雷达迁移由 `RADAR_READING_MODE` 控制，默认值为 `browser`。新同步尽量抓取来源正文用于当次摘要和评分，但不持久化全文；后续 enrichment/recovery 队列保持关闭。专题刷新、议题提取与综合仍要求已完成 enrichment、正文质量和内容审核，因此不会自动消费 external-reading 候选。显式设置为 `enriched` 才运行旧的站内正文链路；历史行和显式 Admin enrichment 保留，便于渐进迁移和回滚。

## 4. LLM 路由

业务代码只选择用途，不直接绑定供应商：

| 用途 | 环境变量 | 默认职责 |
|---|---|---|
| 重量级研究 | `RESEARCH_LLM` | gpt-researcher 主流程 |
| 工具型调用 | `UTILITY_LLM` | 评分、摘要、审核、聊天、热点聚类 |
| 统一备用 | `FALLBACK_LLM` | 主路由失败后的 fallback |
| Reader 图像翻译 | `READING_VISION_LLM` | 默认跟随 `UTILITY_LLM`；可单独指定可接收图片的模型 |

格式统一为 `<provider>:<model>`。当前默认模型路由为 MiniMax 主模型、DeepSeek fallback；凭据只通过运行时环境注入。旧的 `SMART_LLM`、`FAST_LLM`、`STRATEGIC_LLM`、`BRIEF_LLM` 只作为兼容镜像，不是业务真相源。

Reader 平台模式图片翻译仅接收扩展从当前页面读取的 PNG/JPEG/WebP 图片字节，不接收远程 URL 供服务端抓取。默认复用 `UTILITY_LLM`，因此该路由必须支持图片输入；若部署提供独立视觉模型，可设置 `READING_VISION_LLM` 覆盖。MiniMax-M3 的真实视觉请求已确认可调用，但合成图文字识别与坐标覆盖质量尚未通过验收；不能将接口连通性视作图片翻译可用。详细真实调用记录保存在本机未纳入版本控制的 `docs/PROJECT_STATUS.md`。

共享 LLM client 负责有限重试、fallback、endpoint 熔断和 token usage 审计。业务 worker 仍必须提供自己的确定性降级或可恢复状态，不能用空结果冒充成功。

Token 用量预算由 `LLM_TOKEN_BUDGET_USER_LIMIT`、`LLM_TOKEN_BUDGET_USER_PERIOD_DAYS` 和 `LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT` 配置，两个额度上限默认 `0`（关闭）。个人额度按滚动天数计算，平台额度按 UTC 自然日计算；输入和输出 token 均计入。启用额度时，长篇 Reader 整页问答/解释、研究助手全文改写/摘要/反方观点、事实核验的声明清单会在首个模型调用前按全部分块预留额度，结束后按实际 usage 结算；其他调用仍按单次模型调用预留。供应商不返回 usage 时按预留量结算，未完成的预留在 TTL 到期后回收。额度触顶时当前明确暂停新任务并返回额度错误，不做排队；账本或数据库不可用时失败关闭，返回服务不可用状态。

## 5. 认证与权限

- 默认开放邮箱密码注册/登录；`AUTH_BETA_MODE=1` 时，密码注册和 OAuth 首次开户都只接受 Admin 预先加入白名单的邮箱；
- `AUTH_EMAIL_VERIFICATION=1` 时，密码注册必须先通过 SMTP 邮件中的一次性验证码；验证码仅以 HMAC 形式持久化，并有过期、重发和尝试次数限制；
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
