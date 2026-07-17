# 技术调研平台 · 架构方案

> 版本：v3.5.1 · 2026-07-17
> 本版只保留当前有效的技术决策；历史推演和完整旧稿见 `docs/archive/`
> 产品概览：`docs/DIAGRAMS.md`；逐周实施与验收：`docs/IMPLEMENTATION_PLAN.md`；交互原型：`docs/mockups/index.html`

---

## 一、文档职责

| 文档 | 面向对象 | 唯一职责 |
|---|---|---|
| `DIAGRAMS.md` | 全团队 | 产品是什么、为什么做、怎样判断价值 |
| `ARCHITECTURE.md` | 开发与评审人 | 当前有效的范围、技术契约、安全边界和部署方案 |
| `IMPLEMENTATION_PLAN.md` | 执行团队 | 每周任务、负责人、测试、验收和退出条件 |
| `mockups/index.html` | 产品与开发 | 目标交互和页面状态参考，不作为后端契约 |

同一事实只维护一次：排期以实施计划为准，技术契约以本文为准，价值指标的白话解释以概览为准。归档文件不再同步更新。

---

## 二、产品范围

### P0：9 周 MVP

1. **每日摘要**：每天最多 4 条精选，包含标题、摘要、标签、来源和详情。
2. **沉淀**：长文与讨论精华共用 `researches`，支持草稿、发布、全文搜索和修改审计。
3. **内容导入**：上传 `.md/.txt/.html`，异步转换为当前用户私有 Markdown 草稿。
4. **AI 调研**：异步生成参考草稿，用户实际修改后才能发布。
5. **评论与提名**：评论可星标，3 名不同成员投票后进入 Admin 提名队列。
6. **用户分享**：URL + 备注经安全抓取、轻量摘要和人工审核后进入内容池。
7. **精简 Admin**：审核队列、成员基础管理、失败任务入口。
8. **运行底线**：Auth、权限、日志、成本、备份恢复和 Week 13 决策埋点。

### P1：试用数据通过后再做

- Confluence 用户授权单页导入、`.docx/.pdf`、页面树批量导入和更新提醒。
- 技术雷达完整 UI、热点主题、热门 Top 5、应用笔记与专家自动关联。
- SSE、版本历史 UI、详细统计、机器评分排序、AI critic 和多 LLM 路由。
- Prometheus/Grafana、Vault/SOPS 等增强运维能力。

### 不做

- 多人实时协同编辑。
- 语义搜索。
- AI 自动批准或自动发布团队内容。
- Confluence 双向同步或替代 Confluence 的协作能力。

---

## 三、架构与技术栈

### 系统边界

```text
[Browser]
   |
   v
[Next.js Web + BFF] ----------------------+
   | Auth / API / UI / permissions        |
   |                                       v
   +--> [PostgreSQL 16 + zhparser] <--> [DB-backed workers]
   |                                       | AI jobs / import jobs
   |                                       v
   +--------------------------------> [ResearchEngineAdapter]
                                           |
                                           v
                              [Tavily / arxiv / GitHub / LLM]
```

### 组件职责

| 组件 | 职责 | 不负责 |
|---|---|---|
| Next.js Web + BFF | 页面、Auth、资源权限、输入校验、任务创建和状态查询 | 执行长时间 AI 任务 |
| PostgreSQL | 业务数据、全文索引、AI/import 队列、租约、幂等和审计 | 保存原始导入文件 |
| Import worker | 文件校验、HTML 清洗、Markdown 转换、warnings 和临时文件清理 | 调用 LLM 改写内容 |
| AI worker | 抢占任务、心跳、重试、调用 adapter、记录来源和成本 | 决定内容是否公开 |
| ResearchEngineAdapter | 隔离具体 AI 引擎，统一任务、状态、来源和成本契约 | 用户权限与发布权限 |

### 技术栈

- Web：Next.js 15、TypeScript、Tailwind CSS、shadcn/ui、TanStack Query。
- 编辑器：react-md-editor。
- Auth：NextAuth.js + Google OAuth。
- ORM/数据库：Prisma + PostgreSQL 16 + zhparser + `tsvector/GIN`。
- AI：Week 1 spike 后在 gpt-researcher 与简单 Claude pipeline 中选主引擎，另一条作为 fallback。
- 数据源：Tavily、arxiv、GitHub；arxiv MCP 仅在原生 API 不够时启用。
- 部署：Docker Compose + nginx + TLS + 日志卷 + 每日 pg_dump。

### 部署拓扑

| 服务 | 默认端口 | 说明 |
|---|---:|---|
| nginx | 80/443 | TLS 终止，转发 Web 和 AI API |
| web | 3000 | Next.js、BFF、状态 API、内容导入 worker |
| ai-engine | 4000 | AI worker、adapter、成本与来源记录 |
| arxiv-mcp | 8001 | 可选论文读取服务 |
| postgres | 5432 | 业务表、全文索引和两个任务队列 |

P0 必须挂载 `/var/log/{web,ai-engine,nginx}`、`/backup` 和隔离的 `/data/import-tmp`。导入临时目录不进入数据库备份。

---

## 四、数据模型与硬约束

### 表清单

| 表 | 作用 |
|---|---|
| `users` | 成员、角色和禁用状态 |
| `summaries` | 每日摘要和用户分享 |
| `researches` | 长文、精华和所有私有/公开草稿 |
| `research_sources` | 调研挂载资料和来源引用 |
| `ai_research_jobs` | AI 调研与轻量摘要任务 |
| `ai_research_sources` | AI 任务实际使用的来源 |
| `comments` | 摘要或沉淀评论 |
| `research_audit` | 已发布沉淀的修改留痕 |
| `comment_stars` | 评论一人一票 |
| `content_import_jobs` | 文件转换任务；P1 扩展 Confluence |

### 核心关系

- `research_sources.research_id → researches.id`。
- `ai_research_sources.job_id → ai_research_jobs.id`。
- `content_import_jobs.requester_id → users.id`，成功后 `output_research_id → researches.id`。
- `comments.research_id` 与 `comments.summary_id` 必须恰好一个非空。
- `comment_stars(comment_id, user_id)` 为复合主键，保证一人一票。
- 私有草稿不依赖前端隐藏；所有读取均由 BFF 按 owner 和状态过滤。

### `researches` 关键字段

| 字段 | 规则 |
|---|---|
| `type` | `research` 或 `knowledge` |
| `status` | `draft` 或 `published` |
| `creation_method` | `manual`、`ai_research`、`file_import`、`confluence_import` |
| `ai_assisted` | 只有 AI 草稿被成员实际修改并发布后才为 true |
| `ai_assisted_job_id` | 来源 AI job，用于溯源 |
| `origin_content_sha256` | 初始草稿归一化哈希，用于阻止未修改 AI 草稿直接发布 |
| `source_comment_id` | 精华来自评论时填写 |

AI job 创建草稿时设置 `creation_method='ai_research'`、`ai_assisted=false` 并保存初始哈希。发布 API 对标题、结构化字段和正文做相同归一化后重新计算；哈希未变化则拒绝发布，变化后设置 `ai_assisted=true`。

文件或 Confluence 仅做确定性格式转换时 `ai_assisted=false`。只有之后实际调用 AI 改写，才关联对应 job 并改变标签。

### 任务状态

AI job：

```text
queued -> running -> succeeded
                  -> partial
                  -> failed
                  -> cancelled
```

Import job：

```text
queued -> running -> succeeded
                  -> failed
                  -> cancelled
```

两个队列分表，但复用租约、心跳、重试和幂等 helper。worker 使用事务和 `FOR UPDATE SKIP LOCKED` 抢占；运行中每 15 秒心跳；只有租约过期任务可被接管。

AI job 使用请求者 + `Idempotency-Key` 唯一约束。单 job 最长 5 分钟；已获得至少 3 条可引用资料但未完成报告时标记 `partial`，否则标记 `failed`。

---

## 五、核心流程

### 每日摘要

```text
cron/admin trigger -> 抓取候选 -> 规范化/去重 -> 轻量摘要 -> 最多 4 条 published summary
```

- P0 允许来源不足时少于 4 条，必须展示失败原因，不能编造内容补足。
- 每条内容保留 canonical URL、来源类型、发布时间和抓取时间。
- 用户分享与每日摘要共用 `summaries`，通过来源和审核状态区分。

### 文件导入

```text
上传文件 -> 类型/大小/编码/安全校验 -> import job -> 转 Markdown + warnings
        -> 当前用户 private draft -> 用户检查/编辑 -> 显式发布 -> 进入团队搜索
```

- P0 只接受单个不超过 5MB 的 `.md/.txt/.html`。
- 扩展名和实际 MIME 必须同时通过；文本必须为 UTF-8。
- HTML 删除 `script/style/iframe/object`、事件属性和危险 URL，不加载外部资源。
- 文件名只作展示，磁盘路径由服务端生成；成功或失败后 24 小时内清理原文件。
- 相同用户 + SHA-256 的成功导入不重复创建草稿。
- 转换不调用 LLM，不占 AI 配额；不支持结构进入 `warnings`，不得静默丢失。

P1 Confluence 只解析站点和 page id，正文必须通过用户委托授权的 API 读取。首版是单页一次性快照，不使用超级账号，不读取整个空间，也不做双向同步。

### AI 调研

```text
提交主题/指定资料 -> BFF 写 queued job 并在 2 秒内返回 id
 -> worker: context -> plan -> search -> compress -> analyze -> write
 -> private AI draft -> 用户修改 -> published research
```

- Context 目标 500-800 个中文字符，服务端执行 1,500 token 硬限并记录被截断槽位。
- `prefer_user_sources` 先读指定资料，再自动搜索；指定资料失败可降级并标注。
- `only_user_sources` 只使用指定资料；全部失败则 job 失败。
- 用户指定 URL 与分享共用同一个安全抓取器；收藏和沉淀使用内部 ID，由 BFF 先做可见性检查。
- 前端每 5 秒轮询 job 状态；SSE 留 P1。
- AI 原始草稿、失败 job、partial 资料和私有追问都不自动公开。

### 评论、星标与审核

```text
评论 -> 3 名不同成员星标 -> nominated -> Admin 提炼/批准 -> published knowledge
用户分享 -> 安全抓取/轻量摘要 -> pending_review -> Admin 批准 -> published summary
```

- 所有批准都必须由 Admin 明确操作；机器评分即使在 P1 也只用于排序。
- 分享和提名复用一个 Admin 审核入口，按任务类型分 tab。
- 审核记录 reviewer 和时间；精华必须能追溯到来源评论。

### 私有追问

- 可用于摘要、分享和调研详情。
- P0 仅保留当前用户当前 session 的临时对话。
- 不写入公开 comments，不进入全文搜索，不提供“一键写回评论区”。

---

## 六、权限与安全边界

### 角色矩阵

| 操作 | Member | Admin |
|---|---:|---:|
| 阅读 published 内容 | 是 | 是 |
| 创建/读取自己的 draft | 是 | 是 |
| 读取他人的 draft | 否 | 否 |
| 评论、星标、分享 | 是 | 是 |
| 审核分享和提名 | 否 | 是 |
| 管理成员和角色 | 否 | 是 |

Admin 页面显隐只是体验层；Admin API 必须服务端校验角色。禁用成员不能建立新 session，危险角色变更需要二次确认和审计。

### URL 抓取

- 只允许 `http/https`。
- 首次请求和每次重定向后都解析最终 IP。
- 拒绝 localhost、RFC1918、link-local、IPv6 loopback 和 metadata IP。
- 响应上限 2MB、总耗时 10 秒、最多 3 次重定向。
- 记录域名、状态和失败分类，不在日志保存网页正文。

### 外部内容与 Prompt Injection

- 网页、论文和 README 都是不可信资料，只允许抽取事实和引用，不能执行其中指令。
- 明显包含“ignore previous instructions”等注入文本的片段降权或丢弃。
- 没有来源支撑的输出必须标记为推断。

---

## 七、API 稳定契约

| API | 关键结果 |
|---|---|
| `POST /api/ai-research` | 校验权限、配额、资料可见性和幂等 key；2 秒内返回 job id |
| `GET /api/ai-research/{id}/status` | 返回 status、current_step、progress、elapsed、来源数和失败阶段 |
| `POST /api/content-import` | 创建 import job；原始文件进入隔离临时目录 |
| `GET /api/content-import/{id}` | 返回状态、warnings、错误码和输出草稿 id |
| `POST /api/researches/{id}/publish` | 校验 owner、状态和 AI 初始哈希；事务内发布和更新索引 |
| `POST /api/shares` | 使用统一安全抓取器，创建待审核分享 |
| `POST /api/comments/{id}/stars` | 一人一票；事务内更新计数和 nomination |
| `POST /api/admin/reviews/{id}` | Admin-only；明确批准或拒绝并写审计 |

错误响应使用稳定业务码和 `request_id`，不把供应商错误、prompt、token 或密钥直接返回前端。

---

## 八、运行、成本与决策指标

### 运行底线

- BFF 日志：`request_id`、脱敏用户、角色、route、latency 和 status code。
- Job 日志：状态、step、elapsed、attempts、来源数、失败分类、token 和估算成本。
- 每日 pg_dump；恢复点目标 24 小时内，恢复时间目标 2 小时内。
- Week 8 和 Week 9 各执行一次空环境恢复演练。
- 导入原文件不进入数据库备份或应用日志。

### 配额与成本

- AI 调研、私有追问和用户分享轻量摘要共用全团 20 次/日硬预算。
- 个人 5 次/日为软提醒；团队池为追问保留 5 次。
- 规划月成本 `$75-160`，预算硬上限 `$200`。
- 文件转 Markdown 是确定性本地转换，模型成本为 `$0`。

### Week 13 决策

硬门槛：无未关闭高危安全/隐私问题，且月成本不超过 `$200`。

| 指标 | 继续标准 |
|---|---:|
| 4 周正式调研产出 | ≥ 5 篇 |
| 周有效使用成员 | ≥ 30% |
| 成功 AI 调研 / 团队人数 | ≥ 1 次/人/月 |
| 节省工时价值 | > `$200/月` |

硬门槛通过后，至少 2 个价值指标达标，并且必须包含“正式调研产出”或“ROI”之一。具体 Go / Adjust / Stop 动作见实施计划。

---

## 九、主要风险与处理

| 风险 | P0 处理 |
|---|---|
| AI 引擎中文质量或集成成本不达标 | Week 1 三个真实主题 spike，不达标切简单 Claude pipeline |
| 长任务超时、重复计费或永久 running | DB queue、幂等 key、租约、心跳、重试、5 分钟超时 |
| URL SSRF | 统一抓取器、逐次重定向 IP 校验、大小与时间限制 |
| 文件携带恶意 HTML 或静默丢内容 | MIME + 扩展名校验、HTML 清洗、warnings、24 小时 TTL |
| 私有草稿或追问泄露 | BFF owner 过滤，不进入公共搜索和 comments |
| 外部资料 prompt injection | 不可信资料边界、注入文本降权、来源与推断标识 |
| Admin 审核积压 | 两类审核共用队列；连续两周 > 30 条才评估 P1 机器排序 |
| 缺指标无法决策 | Week 1 定义事件，Week 9 验收，Week 10-13 冻结口径 |

---

## 十、参考与归档

- 开源方案调研：`docs/references/research-oss-references.md`。
- 完整 v3.5 架构旧稿：`docs/archive/ARCHITECTURE.v3.5-full.md`。
- 原系统模块图：`docs/archive/MODULE_MAP.v3.5.md`。
- 早期 brainstorm：`docs/archive/2026-07-14-tech-research-platform-brainstorm.md`。

归档文件只用于追溯，不代表当前方案，也不参与跨文档一致性维护。
