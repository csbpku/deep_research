# 产品重构研发计划

**计划版本**：2026-08-10
**状态**：已完成（代码、隔离测试、日报模型删除、主库迁移、服务重启和真实雷达同步均已验证）
**注意**：2026-08-11 主库曾被 E2E fixture 清空；经用户明确确认接受空库后，已按当前 `apps/web/.env` 的 `deep_research` 目标库重新初始化。本计划文件仅作本地研发记录，不进入 Git。
**主线目标**：技术雷达首页化、匿名阅读、双栏 AI 阅读工作台、主题自动更新、对话式 AI 调研，以及稳定的正文 Markdown 处理链路。

## 一、产品目标与已确认决策

- 技术雷达成为 `/` 首页。
- 移除总览和每日日报的产品入口；日报相关页面、API、生成流程和专用字段已彻底下线。
- 搜索保留为全局能力，通过顶部搜索入口和快捷键访问，不再作为独立 Tab。
- 桌面端和移动端统一使用顶部主导航。
- 技术雷达列表和详情匿名可读。
- 匿名用户可以阅读摘要、正文、翻译和 AI 阅读结果；收藏、反馈、评论、聊天和深入调研仍需登录。
- 雷达详情首期提供原文阅读、AI 阅读、翻译三种模式，并保留可展开 AI 聊天窗口。
- 热点主题采用预设主题 + 定时更新；首期不开放用户自定义主题。
- AI 调研从表单改为对话工作区，首期产出 Markdown 研究稿，同时使用可扩展 artifact 协议为 Slides 等类型留出接口。
- GBrain 只作为候选的知识检索/综合 sidecar，不直接替换雷达、主题或 AI 调研业务事实源。

## 二、实施顺序与阶段

### P0：正文抽取、Markdown 标准化与统一渲染

**当前状态**：已完成，并通过 Web 单测、Python 全量非 DB/E2E 集合和 production build。

这是 AI 阅读、翻译、高亮和聊天的基础依赖。

- 统一网页正文抽取函数：Trafilatura Markdown 输出为默认路径；正文过短、验证码页或质量不足时进行有限重试和来源专用 fallback。
- 来源专用 fallback 只负责定位正文 HTML，最终统一进入 HTML-to-Markdown 转换器；禁止使用“正则清标签后压成一行纯文本”的路径。
- 原始正文与 AI 生成内容分离保存。`originalMarkdown` 保存完整抓取正文；`body` 只承担摘要、简版正文或降级展示。
- 增加确定性的 Markdown normalizer：换行、控制字符、标题/列表/引用/代码块、链接、超长单行和 hash 规范化。
- 记录正文来源 URL、抓取时间、内容 hash、extractor 版本、来源类型、质量评分和 warnings。
- 正式正文统一使用 `MarkdownContent`；导入预览和 AI 结果预览复用同一套安全 Markdown AST/render pipeline。
- 默认不渲染任意 HTML；链接只允许 `http`、`https`、`mailto`；代码块、表格和长 URL 必须可响应式展示。
- 建立正文 golden fixtures：博客、RSS、GitHub、arXiv、中文长文、表格、代码块、脚注、异常 HTML、验证码页和恶意链接。

**P0 验收**：

- 标题、段落、列表、表格、链接、脚注和代码块结构稳定。
- 抓取失败或内容低质量时不产生伪正文。
- 任意 Markdown 输入不会导致 XSS、渲染异常或横向溢出。
- 正文 hash 稳定，重新抓取后可以识别版本变化。

### P1：信息架构与导航

**当前状态**：已完成；日报页面和日报 API 已删除，旧日报路径返回 404；完整 Chromium E2E 已通过。

- `/` 改为技术雷达入口。
- 移除总览和日报页面、导航项、跳转链接及相关测试契约；摘要记录统一通过雷达详情展示。
- 桌面侧栏改为顶部主导航；移动端保留紧凑顶部导航和必要的抽屉交互。
- 搜索改为顶部命令入口和 `⌘K/Ctrl+K`，保留 `/search` 作为可访问路由但不再作为主导航 Tab。
- 修正全站返回路径、页面上下文标题、移动端导航和 E2E 选择器。

### P2：技术雷达匿名阅读与双栏详情

**当前状态**：已落地匿名读取、双栏模式栏、翻译/AI 阅读 API、source hash 缓存和匿名限流；翻译与 AI 阅读真实样本均已成功。

- `GET /api/radar` 和 `GET /api/radar/:id` 支持匿名读取。
- 公开数据与用户个性化字段分离；互动动作继续执行登录权限校验。
- 详情页改为双栏研究工作台：
  - 左侧：标题、AI 摘要、正文、来源和段落定位。
  - 右侧：模式选择、证据卡、相关雷达和操作。
- 首期模式为原文、AI 阅读、翻译。
- AI 阅读与翻译结果按 `contentHash + mode + language` 缓存。
- 段落使用稳定 ID、hash 和 offset 支持高亮、翻译、评论和引用。
- `AskAiDrawer` 改为可展开聊天窗口；移动端使用单栏和抽屉模式。

### P3：热点主题自动更新

**当前状态**：预设主题字段、默认配置、关键词匹配、失败保留旧综述、真实聚合和 cron 日志均已验证。

- 预设主题包含名称、slug、描述、关键词/来源规则、刷新频率和启用状态。
- 定时从雷达候选聚合主题内容，生成综述、变化信号、趋势/时间线、相关条目和证据引用。
- 保存输入候选、生成时间、模型版本、内容 hash 和生成状态。
- 生成失败时保留上一版本，并展示更新时间与状态。
- 优先复用现有 Topic、TopicCandidate 和 topic refresh worker，避免重复建模。

### P4：对话式 AI 调研与 artifact 协议

**当前状态**：已完成；对话入口、artifact schema、runner、Slides Markdown 生成、slide cards、真实 Slides job 和 DB constraint 均已验证。

- `/ai-research` 改为对话工作区：目标澄清、范围确认、来源选择、启动任务、进度、结果和继续追问在同一体验内完成。
- 复用现有异步任务状态机、来源安全抓取、配额、成本和审计。
- 抽象统一 artifact：类型、标题、metadata、内容/payload、来源引用、版本和状态。
- 首期实现 Markdown 研究稿；Slides、表格和图表作为后续 artifact 类型。
- 结果页根据 artifact 类型选择预览、编辑、下载或继续对话。
- 历史 AI 调研任务保持兼容读取。

### P5：GBrain 知识层试点

**当前状态**：已完成 v1 试点；非空代表性语料 query、相关结果命中和无效 token 拒绝均已验证；更大规模 benchmark 属于后续优化。

- 独立部署 GBrain，不直接共享 Prisma 业务表。
- 当前为只读消费侧：业务侧不向 GBrain 推送数据；AI engine 通过只读 HTTP/MCP 客户端按需调用 GBrain。后续若需要反向写入，将单独规划。
- 通过窄接口向 AI engine 提供 `search_context`、`synthesize_topic`、`find_related_radar`；`find_conflicts` 和 `find_evidence_gaps` 预留为后续扩展。
- 调用载荷沿用原项目实体 ID、来源 URL 和 `sourceHash`，便于 GBrain 端做来源回溯（v1 不做写入，因此该映射仅用于查询时附带）。
- 先用于单个热点主题和 AI 调研内部资料检索，再评估是否用于雷达详情关联内容。
- 评估引用准确率、召回率、延迟、成本、权限隔离和数据重复维护成本。

## 三、接口与数据约束

- 业务事实源仍是当前 PostgreSQL/Prisma 数据库。
- `originalMarkdown` 不被摘要、翻译或 AI 阅读覆盖。
- AI 生成内容必须携带对应的 `sourceHash` 或来源版本。
- 匿名 API 不返回用户私有状态。
- 任何公开正文都必须经过统一安全 renderer。
- 日报删除已完成数据清理、迁移、旧路径 404 验证和回归验证。
- 重要架构变更同步更新 `docs/ARCHITECTURE.md`、`docs/contracts/` 和 `docs/PROJECT_STATUS.md`。

## 四、测试与发布门禁

- Web 单测：Markdown 解析、链接协议、正文版本、高亮偏移、匿名响应和权限分离。
- Python 单测：正文抽取、Markdown 转换、低质量识别、fallback、hash 和来源 fixtures。
- E2E：匿名雷达列表/详情、三种阅读模式、聊天登录门禁、移动端导航和正文窄屏展示。
- 安全：脚本、事件属性、危险协议、恶意 HTML、远程图片和 SSRF 回归。
- 质量：typecheck、Web 单测、Python pytest、ruff、mypy、production build。
- 迁移：日报数据备份/恢复、字段删除前后数据一致性、历史 AI 任务兼容读取。

## 五、当前执行状态

- [x] 完成产品、架构和正文展示调研。
- [x] 锁定匿名范围、日报处理、雷达模式、主题更新和 AI artifact 方向。
- [x] 创建本计划文件。
- [x] 完成第一轮正文 HTML-to-Markdown 结构化转换和 renderer URL/HTML 安全边界。
- [x] 完成正文抽取路径统一、preview pipeline、质量 metadata 和基础 golden fixtures。
- [x] 完成顶部导航、首页切换、日报生成停止和兼容跳转。
- [x] 完成雷达匿名 API、双栏详情、阅读模式、转换缓存和匿名限流。
- [x] 完成预设主题运营配置、失败回退专项、定时刷新日志和真实聚合。
- [x] 完成对话式 AI 调研入口和 artifact 基础协议。
- [x] 完成真实 Slides AI 调研任务、artifact 结果兼容和 Slides 预览。
- [x] 完成 GBrain 隔离 adapter、只读边界和 topic synthesis 接入。
- [x] 完成实际 GBrain HTTP MCP 实例的 query 往返、代表性语料召回和无效 token 拒绝。
- [x] 完成重构相关 Web 单测和 Python 全量回归。
- [x] 按用户决策接受主库为空，完成 `deep_research` 主库 reset；随后应用日报删除迁移，共 37 个迁移。
- [x] 在主库重新注册 4 个有明确配置证据的雷达数据源，并完成一次真实同步；未把未注册 fetcher 当作已配置数据源。
- [x] 删除日报数据模型、页面/API、生成器、cron 产物和日报收藏枚举，并完成结构/运行态验收。

## 六、最终验收证据（2026-08-11）

- 主库目标：`apps/web/.env` 中的 `postgresql://postgres:postgres@localhost:5432/deep_research`。
- 主库初始化：`pnpm --filter @deep-research/web db:reset` 成功；随后 `db:deploy` 应用 `20260811000003_remove_daily_digest`，当前 37/37 migrations applied。
- 初始化数据：执行 `apps/web/prisma/seed.sql` 成功；`radar_sources=4`。
- 日报删除核验：`summaries.digestMeta` 不存在；`BookmarkTargetType` 仅剩 `radar_candidate/summary/research/knowledge`；主库 `digest://` 摘要为 0；`GET /api/summaries` 返回 404。
- 主库同步后数据：`summaries=29`，全部为雷达候选；4 个 source run 为 `1 completed / 2 partial / 1 failed`，失败原因分别为 WeWe 账号过期、单条文章抓取/AI 失败和 arXiv 上游限流。
- 主题同步后数据：预设主题 `3` 条，已关联候选 `7` 条；证明后台 enrichment/主题阶段完成后再读取结果。
- 运行态：launchd 的 Web/AI 两个 job 均为 running；Web `/api/healthz=200`、AI `/healthz=200`、`/api/radar=200`。
- Prisma：`migrate status` 报告 schema up to date；`prisma validate` 通过。
- 回归验收：Web 单测 `41 files / 370 passed`；Python 全量 `471 passed / 1 skipped`；DB 集成测试 `16 passed`；ruff、mypy、typecheck 均通过。
- 隔离 Chromium E2E：`15 passed / 1 skipped`（`contract.spec.ts` + `public-flows.spec.ts`，目标库为 `deep_research_test`）；production build：53 routes 成功。
- 研发计划文件继续保持未跟踪，不加入 Git。
