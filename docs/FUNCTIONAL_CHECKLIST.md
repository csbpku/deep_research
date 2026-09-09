# 功能清单与验收矩阵

> 这是一份面向后续测试的当前功能清单。它回答三个问题：用户从哪里进入、主路径是什么、出错时能不能恢复。
>
> 它不替代 [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) 的项目进度，也不替代 [`E2E_TESTING.md`](./E2E_TESTING.md) 的运行说明。每次功能行为变化时，先更新这里的主路径和覆盖状态，再在状态文档记录本轮证据。

## UI/UX 覆盖状态

本清单中的全部 `33` 个功能 ID 和 `10` 个短冒烟 ID，均已在 [`ui-ux-review-20260908-round2.md`](./ui-ux-review-20260908-round2.md) 建立对应的 UI/UX 行级记录。该矩阵另外拆分：

1. 页面可达；
2. 控件可操作；
3. 加载 / 成功 / 失败 / 禁用反馈；
4. 刷新、返回或列表中的结果回读；
5. 重试、取消、关闭或返回等失败恢复。

UI/UX 状态不等于业务功能端到端通过：`🟡` 和 `⏸` 会明确保留未执行的 OAuth、文件选择、正式发布、运营性变更和备份恢复边界，避免把“页面能打开”误报成“功能已验收”。

## 使用规则

### 状态含义

- `✅` 主路径已实现，并有近期自动化或真实浏览器证据。
- `🟡` 主路径已实现，但仍有边界、外部依赖或恢复路径需要继续验收。
- `⏸` 被外部凭据、网络或环境条件阻塞，不能把代码存在当作功能通过。
- `🔁` 最近发生了行为变化，必须重新跑对应验收，旧证据暂不沿用。

### 每次改动后的顺序

1. 先跑与改动直接相关的单测/API 测试。
2. 再跑下面的短冒烟路径，确认页面、权限、成功反馈和失败恢复。
3. 触及跨模块状态、异步任务、来源或发布门禁时，补跑对应的真实浏览器或真实服务验收。
4. 在本文件更新“覆盖状态”和“证据入口”；详细数字与过程写入 `PROJECT_STATUS.md` 或 weekly 记录。

## 短冒烟路径

这是日常改动后优先执行的最小集合。无需每次把所有历史任务和所有来源重新跑一遍。

- [ ] `SM-01` 匿名进入 `/`、`/radar`、`/researches`、`/topics`、`/ai-research`，页面有明确空态或内容，不能出现 500、白屏或错误导航。
- [ ] `SM-02` 登录后打开 `/me`，用户菜单、最近内容和通知入口可达；匿名访问需要权限的操作时有登录提示或 401/403。
- [ ] `SM-03` `/radar` 列表 → 详情：标题、快速判断、内容形态、来源和正文可见；详情返回列表后筛选/分页仍可用。
- [ ] `SM-04` 雷达详情按需打开 AI 讨论；输入一条消息，成功、超时和重试状态都不能让页面卡死。
- [ ] `SM-05` AI 回答出现后，点击“提炼为知识卡片”才开始提炼；预览可编辑，取消不落库，确认后可在研究库打开。
- [ ] `SM-06` `/ai-research` 创建一次快速判断或研究稿；运行中刷新页面后状态可恢复，终态能区分成功、失败、取消和部分完成。
- [ ] `SM-07` 研究结果 → 来源/证据 → 编辑研究稿：报告、来源账本、质量状态和下一步动作语义一致。
- [ ] `SM-08` 研究稿保存草稿、修改后发布；未修改或质量门禁未满足时不能伪装成可发布。
- [ ] `SM-09` `/search` 搜索研究内容；结果可打开，空结果、无效输入和未登录边界有明确反馈。
- [ ] `SM-10` Admin 打开 `/admin`；权限拦截、异常摘要、队列/治理入口和操作后的反馈可见。

## 功能验收矩阵

### 账户与全站基础

| ID | 功能 | 主路径 | 必测边界 | 覆盖证据 | 状态 |
|---|---|---|---|---|---|
| `ACC-01` | 登录与权限 | Google 登录或邀请码激活邮箱密码 → 首页 → 用户菜单 | 非 allowlist 邮箱；错误邀请码；公开注册被拒绝；错误密码；匿名访问私有资源；普通成员访问 Admin；失效会话 | `public-flows.spec.ts`、认证 API/密码单测、`contract.spec.ts` | 🔁 |
| `ACC-02` | 全站导航与首访 | 首页进入雷达、专题、研究库、AI 调研、我的 | 空态、慢加载、路由返回、窄屏不溢出 | `home-flows.spec.ts`、`a11y-axe.spec.ts` | ✅ |
| `ACC-03` | 我的空间与偏好 | `/me` 查看草稿、通知、关注和设置 | 空数据、保存失败、权限变化 | `apps/web/src/components/me/` 相关测试 | 🟡 |

### 技术雷达

| ID | 功能 | 主路径 | 必测边界 | 覆盖证据 | 状态 |
|---|---|---|---|---|---|
| `RAD-01` | 候选发现与列表 | 来源筛选 → 候选列表 → 分页/排序 | 没有候选；来源失败；重复候选；旧缓存 | `radar-flows.spec.ts`、radar sync/enrichment tests | 🟡 |
| `RAD-02` | 雷达详情阅读 | 列表 → 详情 → 快速判断 → 原文 | GitHub/Zread、RSS、社区、arXiv、用户分享的内容形态差异 | 雷达详情定向测试、`PROJECT_STATUS.md` 真实浏览器记录 | 🟡 |
| `RAD-03` | 正文质量与渲染审核 | 正文完整性 → 内容审核 → 页面呈现审核 | `partial`、`failed`、`manual`、图片/表格/公式/Mermaid/横向溢出 | `test_enrichment_worker.py`、`test_structured_html.py`、render-review 记录 | 🟡 |
| `RAD-04` | 阅读动作 | 文章地图、选中文本解释/翻译/问 AI/批注/复制引用 | 匿名态不可用动作；定位失败；AI 连接超时；移动端滚动 | `RadarArticleHighlights`、`RadarOriginalArticle`、`ChatPanel` tests | 🟡 |
| `RAD-05` | 雷达反馈与治理 | 收藏/反馈 → Admin 负向治理 → 恢复 | 重复操作幂等；软屏蔽不删除历史；恢复后可见 | `cognition-v2-flows.spec.ts`、radar API tests | ✅ |

### 专题、搜索与协作

| ID | 功能 | 主路径 | 必测边界 | 覆盖证据 | 状态 |
|---|---|---|---|---|---|
| `TOP-01` | 专题关注与未读 | 关注专题 → 查看议题 → 标记已读 | 重复关注；无议题；已读状态刷新后保持 | `topics` tests、`contract.spec.ts` | ✅ |
| `TOP-02` | 专题聚合与综述 | 专题详情 → 热点议题 → 引用回链 | 聚合任务失败；引用缺失；旧快照与新快照 | topic worker tests、`PROJECT_STATUS.md` | 🟡 |
| `SEA-01` | 全文搜索 | 输入关键词 → 结果 → 打开研究/卡片 | 空查询、特殊字符、无结果、权限过滤 | `cross-flows.spec.ts`、search tests | ✅ |
| `COL-01` | 评论、回复与通知 | 评论 → @成员/回复 → 通知 → 已读 | 重复提交；嵌套计数；被提及者权限；通知幂等 | `test_comments_e2e.py`、discussion tests | 🟡 |
| `COL-02` | 批注与引用 | 选中文本 → 批注/复制引用 → 回到正文 | 文本定位失效；正文版本变化；匿名态 | radar reading tests、真实详情页验收 | 🟡 |

### AI 调研与研究产物

| ID | 功能 | 主路径 | 必测边界 | 覆盖证据 | 状态 |
|---|---|---|---|---|---|
| `AI-01` | 调研入口与澄清 | 输入问题 → 选择产物/资料 → 确认 brief | 缺少主题；可选字段为空；只使用用户资料；取消 | `ai-research-flows.spec.ts`、plan/context tests | ✅ |
| `AI-02` | 快速判断 | 提交 → 短时间返回方向性判断 | 无来源时明确“模型摘录”；不创建正式研究稿；失败可重试 | `ArtifactPreview` tests、`PROJECT_STATUS.md` 真实验收 | ✅ |
| `AI-03` | 深度研究运行 | 计划确认 → 多轮研究 → 进度/来源/证据 → 结果 | 刷新恢复；额度不足；检索波动；超时；部分结果保留 | `test_ai_research_e2e.py`、research adapter tests、运行页真实验收 | 🟡 |
| `AI-04` | 四种产物 | 研究稿、快速判断、Slides 提纲、网页简报分别生成和打开 | 产物语义不能混淆；Slides 不声称 `.pptx`；网页简报独立阅读 | `ArtifactPreview.test.ts`、`ResearchOutputViews.test.ts`、week14 记录 | ✅ |
| `AI-05` | 追问与修订 | 结果页追问 → answer/verify/revise/action → 必要时生成新版本 | 普通回答不能生成版本；跨任务消息不能引用；来源需重新绑定 | revision route tests、`PROJECT_STATUS.md` | ✅ |
| `AI-06` | 结果与证据账本 | 结果页查看摘要、来源、证据地图、使用建议 | 执行完成不等于事实通过；来源无正文；证据不足；审核不可用 | review UI/API tests、真实结果页验收 | 🟡 |
| `AI-07` | 事实审核与发布边界 | 审核声明 → 证据关系 → 作者决定 → 发布 | 旧版本审核失效；覆盖不足；冲突不能直接接受为确定事实 | reviewer tests、review route tests、审核真实验收 | 🟡 |

### 研究库与知识沉淀

| ID | 功能 | 主路径 | 必测边界 | 覆盖证据 | 状态 |
|---|---|---|---|---|---|
| `RES-01` | 研究库列表与筛选 | `/researches` → 成果/草稿/我的已发布 → 类型筛选 | 空库；归档；权限过滤；知识卡片与研究稿混排 | `researches-flows.spec.ts`、research API tests | ✅ |
| `RES-02` | 研究稿编辑与版本 | 打开草稿 → 编辑 → 保存 → 查看历史/恢复 | 未保存离开；并发编辑；旧版本恢复；正文 hash 变化 | `editor-workbench.spec.ts`、research route tests | ✅ |
| `RES-03` | 显式提炼知识卡片 | AI 回答 → 点击提炼 → 编辑预览 → 确认保存 | 不点击不调用；取消不落库；回答归属校验；来源/审计完整 | `knowledge-routes.test.ts`、`KnowledgeCardComposer` tests、真实验收 | ✅ |
| `RES-04` | 发布与归档 | 草稿发布 → 已发布详情 → 归档/恢复 | 未修改草稿不能发布；质量门禁；权限；归档后搜索/列表语义 | publish/archive route tests、研究库真实验收 | 🟡 |

### 导入、分享与后台任务

| ID | 功能 | 主路径 | 必测边界 | 覆盖证据 | 状态 |
|---|---|---|---|---|---|
| `IMP-01` | 文件导入 | 上传 `.md/.txt/.html` → 异步转换 → 私有草稿 | 超大文件；恶意 HTML；转换失败；任务重试；临时文件清理 | `test_import_samples.py`、import route/worker tests | ✅ |
| `IMP-02` | Confluence 导入 | OAuth → 选择页面 → 转换为草稿 | OAuth 凭据、权限拒绝、远端限流、页面版本变化 | Confluence import code/tests | ⏸ |
| `SHR-01` | URL 分享 | 提交 URL → SSRF-safe 抓取 → 候选/审核 → 进入雷达 | 私网地址、重定向、超时、无正文、审核拒绝 | submission worker/API tests | 🟡 |
| `JOB-01` | 异步任务状态 | queued → running → heartbeat → terminal/retryable | worker 崩溃、lease 过期、重复领取、迟到写回 | job runner E2E、enrichment tests | 🟡 |
| `JOB-02` | LLM 用量与失败审计 | 调用成功/失败 → 用量记录 → Admin 查看 | fallback、熔断、重试、额度错误、敏感内容不入日志 | `llm-usage` tests、LLM client tests | ✅ |

### Admin 与运维

| ID | 功能 | 主路径 | 必测边界 | 覆盖证据 | 状态 |
|---|---|---|---|---|---|
| `ADM-01` | Admin 权限与控制台 | Admin 登录 → 异常优先摘要 → 进入治理模块 | 非 Admin 拦截；空队列；窄屏；操作失败反馈 | `admin-flows.spec.ts`、Admin route tests | ✅ |
| `ADM-02` | 雷达治理 | 查看候选诊断 → 软屏蔽/恢复 → 查看失败原因 | 不删除来源；重复操作；失败任务可恢复；外部请求有界 | admin radar tests、真实 Admin 验收 | 🟡 |
| `ADM-03` | 审核与分享治理 | 查看内容/渲染/分享状态 → 处理或重试 | 审核状态独立；不能越权发布；失败不能伪装成功 | review/admin tests、PROJECT_STATUS 记录 | 🟡 |
| `OPS-01` | 健康、备份与恢复 | `/healthz`、AI health → backup → restore smoke | 服务部分不可用；恢复后 migration/schema 一致；不暴露内部凭据 | backup/restore E2E、部署文档 | 🟡 |

## 常用测试入口

### Web

```bash
pnpm typecheck
pnpm test
pnpm --filter @deep-research/web test:e2e --project=chromium
```

按功能跑单个 spec：

```bash
pnpm --filter @deep-research/web test:e2e radar-flows.spec.ts
pnpm --filter @deep-research/web test:e2e ai-research-flows.spec.ts
pnpm --filter @deep-research/web test:e2e editor-workbench.spec.ts
```

### AI engine

```bash
cd packages/ai-engine
uv run ruff check .
uv run mypy ai_engine tools
uv run pytest -q
```

只跑异步任务、调研或 enrichment 相关回归：

```bash
uv run pytest tests/e2e/test_job_runner_e2e.py -q
uv run pytest tests/test_research_engine_adapter.py tests/test_research_chat.py -q
uv run pytest tests/test_enrichment_worker.py tests/test_structured_html.py -q
```

## 验收记录模板

每次真实浏览器或外部服务验收，在 `PROJECT_STATUS.md` 或对应 weekly 记录中保留：

```text
功能 ID：
日期 / 环境：
入口与测试账号：
主路径结果：
失败或恢复路径结果：
来源 / 任务 / 研究 ID：
自动化门禁：
未通过项与下一步：
```

## 当前边界

- `✅` 只表示当前主路径有证据，不代表所有来源、所有外部服务和所有移动设备都已通过。
- 真实 AI、可选 Google OAuth、Confluence OAuth、Tavily、GitHub/Zread 和生产部署必须单独记录外部依赖状态；邮箱密码登录不依赖 Google OAuth，但公网验收必须使用 HTTPS。
- 数据库、worker、来源抓取和审核的“已写代码”不能替代真实状态迁移、租约恢复、失败隔离和页面呈现验收。
- `.next-*`、报告、缓存和其他无关工作树改动不属于本清单的清理对象。
