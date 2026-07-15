# 技术调研平台 · 架构方案

> 版本：v3.3.1 · 2026-07-14
> 配套文档：`docs/MODULE_MAP.md` / `docs/DIAGRAMS.md` / `docs/mockups/index.html`
> v3.3.1 增量：补全 mockup 中已落地的 UI 设计（详情页结构化字段、admin 页面、avatar 下拉、跨模块热议、✨ AI 协助字段）

---

## 一、产品形态

**核心动作：**
- AI Deep Research 生成"调研参考草稿"
- 成员在编辑器里修改 → 定稿为正式调研（带 ✨ AI 协助标签，v3.3.1 新增）
- 团队沉淀 + 全文搜索
- 评论区有价值的讨论 → 任意角色提名 → admin 提炼进知识库
- ⭐ 重要标签：3 票自动 nominated，跳过选段+弹窗
- AI 自审（对抗性 review，opt-in）：另一个 LLM 角色"挑刺"，质量分从 70 → 85
- **（v3.3.1 新增）** 跨模块热度聚合（🔥 热议）：每日摘要/用户分享/调研/精华 7 天热度统一排名
- **（v3.3.1 新增）** 详情页结构化字段（背景/结论/风险 3 卡 + 挂载资料列表）

**五大模块**：
1. **每日摘要**（钩子场景）— 5 条/天，AI 摘要 + 启发
2. **🔥 热议**（v3.3.1 新增）— 跨模块 7 天热度聚合，团队活跃信号
3. **沉淀**（v3.3.1 改名，原"调研/知识库"）— 包含长文（type=research）和精华（type=knowledge）两个子分类
4. **AI 调研**（生产场景）— gpt-researcher 端到端生成草稿
5. **用户分享**（UGC 场景）— 用户贴 URL + 备注 → AI 轻量摘要 → 团队可见；支持追问和评论（评论可被提名进精华）

**角色与入口**：
- **普通成员**（v3.3.1 取消"普通同事"和"工程师"区分，扁平）：看到 1-4 模块；avatar 下拉含"我的草稿/收藏/团队热门/通知/设置/退出"
- **🛡️ Admin**（条件显隐）：额外看到顶栏 `🛡️ Admin` tab + avatar 下拉里的"Admin 控制台"红色入口

> 用户分享和每日摘要底层同表（`summaries.source` 区分），详情页 UI 共用（追问 + 评论 + ⭐）。
> 长文和精华底层同表（`researches.type` 区分，v3.3.1 改为正式命名 research/knowledge，与 UI "长文/精华" 对应）。

---

## 二、技术栈（最终）

### 前端
- Next.js 15 (App Router) + TypeScript
- Tailwind CSS + shadcn/ui
- react-md-editor（Markdown 编辑器）
- next-auth.js (Google OAuth)
- TanStack Query
- Prisma ORM

### AI 引擎
- **assafelovic/gpt-researcher**（fork，HTTP server 模式）
- Claude Sonnet 4.5（LLM）
- Tavily（通用搜索）
- arxiv-mcp-server（论文深度检索）

### 数据存储
- PostgreSQL 16 + zhparser（中文分词）
- tsvector + GIN 索引（全文搜索）

### 部署
- Docker + Docker Compose（一键本地/单机部署）
- **P0 必带**：nginx 反向代理 + 日志卷 + 每日 pg_dump 备份（详见 `docs/MODULE_MAP.md` §6 部署视图）
- **P1 再加**：Prometheus/Grafana 监控、Vault/SOPS secrets 管理

---

## 三、系统架构（4 层）

```
┌──────────────────────────────────────────────────────────────┐
│  L1  Web 前端 + BFF  (Next.js 15 + TypeScript)                 │
│  ────────────────────────────────────────────                  │
│                                                                  │
│  业务模块：                                                      │
│  · 📰 摘要  · 📚 调研/知识库  · 🤖 AI 调研  · 🙋 用户分享       │
│  基础设施：🔐 Auth (NextAuth) · 💬 评论 · 🔍 搜索                │
│  · BFF (API Routes / Actions)                                   │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTP
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  L2  AI Deep Research 引擎  (gpt-researcher fork, :8000)       │
│  ─────────────────────────────────────────────                  │
│  6 步 pipeline (与 MODULE_MAP、DIAGRAMS 一图统一)              │
│                                                                  │
│  Step 0  拼装 context (< 500 字硬限)                            │
│     │   ↑ 查 L4 注入「近 30 天相关调研/知识库」                 │
│     ▼                                                           │
│  Step 1  Plan      ← LLM 拆 3-5 个子问题                        │
│  Step 2  Search    ← 并发调 L3 数据源                            │
│  Step 3  Compress  ← 过滤 20-30 条 + 评分                       │
│  Step 4  Analyze   ← 横向对比 + 风险点                          │
│  Step 5  Write     ← 输出 Markdown 草稿                          │
│                                                                  │
│  模式：purpose=research (5 步全跑, 单次 ~$0.25)                │
│       purpose=summary  (Step 1+5 轻量, 单次 ~$0.05)             │
│  LLM：Claude Sonnet 4.5                                          │
└──────────────────────────┬───────────────────────────────────┘
                           │ MCP / HTTPS
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  L3  数据源                                                      │
│      gpt-researcher 内置: Tavily / Serper / arxiv / GitHub    │
│      arxiv-mcp-server: search_papers / read_paper              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  L4  数据存储  (PostgreSQL 16)                                  │
│      · 7 张业务表 + research_audit (P0 必带)                    │
│      · tsvector + zhparser（中文全文搜索）                       │
└──────────────────────────────────────────────────────────────┘
```

---

## 四、模块清单

### P0（MVP，8 周 → 实测 11 周，详见第六部分）

| 模块 | 自研/fork | 工程量 |
|---|---|---|
| Next.js 脚手架 + Prisma + NextAuth | 自研 | 0.5 周 |
| PostgreSQL schema + 7 张表（含 polymorphic comments + ✨ AI 协助字段） | 自研 | 0.5 周 |
| 每日摘要模块 | 自研 | 2 周 |
| 沉淀模块（长文 CRUD + 编辑器 + 挂载资料 + 详情页结构化字段） | 自研 | 2 周 |
| 评论提名 + admin 提炼 → 精华 | 自研 | 1 周 |
| **🔥 热议（跨模块热度聚合，v3.3.1 新增）** | **自研** | **0.3 周** |
| **🛡️ Admin 控制台（4 子 tab：审核/成员/统计/设置，v3.3.1 新增）** | **自研** | **0.5 周** |
| **详情页 + ✨ AI 协助标签（v3.3.1 新增）** | **自研** | **0.3 周** |
| **Avatar 下拉菜单（v3.3.1 新增）** | **自研** | **0.2 周** |
| 三层超时 + 任务状态端点（v3.3 必带，对应风险 A5） | 自研 | 0.5 周 |
| ⭐ 标签 + 3 票自动 nominated（v3.3 必带，对应风险 B3） | 自研 | 0.5 周 |
| 全文搜索（tsvector + zhparser） | 自研 | 0.5 周 |
| **gpt-researcher 集成** | **fork** | **0.5 周** |
| **gpt-researcher 轻量模式（summary_brief）** | **fork 改造** | **0.3 周** |
| **AI 对抗性 review（critic 角色，v3.3 opt-in）** | **自研 + gpt-r. 复用** | **0.5 周** |
| AI 调研工作流（前端启动 + 草稿编辑） | 自研 | 1 周 |
| 用户分享模块（URL+备注 → 轻量摘要 → 追问 + 评论） | 自研 + 复用 | 1 周 |
| Docker Compose 整合 + 部署文档 | 自研 | 1 周 |

> v3.3.1 增量：admin/热议/详情页/avatar 下拉等 UI 加进来，**P0 总工程量从 10.5 周 → 11 周**（+0.5 周）。多出的部分要么吸收，要么砍掉 P1「多 LLM 路由」前移消化。

### P1（v2）
- 多人审核流
- SSE 流式进度
- 调研版本历史
- 多 LLM 路由（LiteLLM）
- **（v3.3 新增）** 知识探索路径可视化（C1）—— 若 AI 调研调用量不达标优先做
- **（v3.3 新增）** critic 模式默认开启（C5 第二阶段）
- **（v3.3.1 新增）** 管理员统计页详细图表

> v3.1 调整：原 P1 的「评论/讨论」已前移到 P0（polymorphic comments 表，调研和摘要共用）。

### P2（不做）
- 多人协同编辑
- 语义搜索

---

## 四点五、AI 调研的 Context 来源（v3.2 新增）

> 解决的问题：用户问"AI 做调研的上下文有哪些"，以及"我们这套架构里 context 怎么流转"。
> 约束：传给 LLM 的拼接 context **硬限 < 500 字**（L2 gpt-researcher 框内已标）。

### 1. Context 来源（按形态分）

| 来源 | 例子 | 形态 | 谁注入 |
|---|---|---|---|
| **用户直接输入** | topic 主题、context 补充字段 | 自由文本 | 用户 |
| **团队内既有知识** | 已发布调研、已提炼知识库条目 | markdown 摘要 | L4 自动带 |
| **团队成员档案** | 谁擅长什么、谁 review 过类似主题 | 关系数据 | L4 关联查询（v2） |
| **实时检索** | Tavily/arxiv/GitHub 现拉 | 原始网页/PDF | L2 内部 |
| **历史对话** | 追问链、AI 调研中间步骤 | 流式累积 | L2 内部 |
| **工具/MCP 返回** | arxiv-mcp-server 的 search/read 结果 | 结构化 JSON | L2 内部 |
| **配置常量** | 公司技术栈、团队规模、已知偏好 | 一次性常量 | 应用配置 |

### 2. Context 流转（按系统边界分）

```
[用户 topic + context 字段]
         │
         ▼
[前端组装 → /api/ai-research]  ◀── 查 L4 注入「近 30 天相关调研/知识库」
         │
         │  query + context (<500 字) + report_type
         ▼
[L2 gpt-researcher]
   Planner ──▶ Execution ──▶ Compress ──▶ Aggregator
   (本地累积全量 context，仅把摘要塞 prompt)
         │
         │  调 Tavily / arxiv-mcp / GitHub
         ▼
[L3 数据源]  ←  不接收团队 context，只看子问题
         │
         ▼
[Markdown 草稿] ──▶ 写 ai_research_jobs + researches(status=draft)
         │
         ▼
[成员编辑器] ──▶ 发布为正式调研
```

### 3. 各边界的 context 形态

**L1 → L2**（前端 → gpt-researcher，500 字硬限）：
```python
{
  "query": "我们该不该用 LangGraph 做多 agent 系统",   # topic
  "context": [                                          # 多源拼接，< 500 字
    "公司技术栈：FastAPI + PG + 已有 LangChain 基础",     # 用户手填
    "团队规模：5 人",                                     # 用户手填 / 自动带
    "近期相关调研：...",                                  # ★ 从 researches 表拉
    "近期相关知识库条目：...",                              # ★ 从 knowledge 条目拉
    "公司偏好：不推荐小众框架，优先看社区活跃度",           # 公司常量
  ],
  "report_type": "research_report",
  "source_urls": []  # 可选：用户预先指定要看的链接
}
```

**L2 内部**（gpt-researcher 三个 Agent 之间）：
- Planner Agent 输出：3-5 个子问题（planner_output.json）
- Execution Agent 输出：50-80 条原始资料 URL + 摘要（context_window.json）
- Compress Agent 输出：20-30 条过滤后 + 评分
- Aggregator：把上面 + user context 拼成最终 prompt

> gpt-researcher 内部有一份**全量 context 累积**在本地（`/workspace/outputs/<run_id>/`），但**只把摘要后的小段塞进 LLM 的 prompt**。所以 500 字硬限是 LLM 真正"看见"的部分。

**L2 → L3**（gpt-researcher → 数据源）：
- Tavily：`search(query, max_results=10)`，query 就是子问题
- arxiv-mcp-server：`search_papers(query, max_results=15)` + `read_paper(arxiv_id)`
- GitHub API：trending + readme

> ⚠️ 数据源**不接收团队 context**——Tavily/arxiv 是公网 API，没有"我们公司"的视角。团队 context 只影响 Planner/Aggregator，不影响子问题的检索词。

**L4（数据库自动注入的 context）**：
- `users` 当前用户 role（**不进 LLM context**，只做后台权限判断）
- `researches` 近 30 天同 tag 的调研（去重后前 5 条标题+链接）
- `knowledge` 近 30 天同 tag 的知识库条目
- `comments` 该用户评论过的相关主题（**不进 LLM context**，进 ranking 加权——避免主观判断污染输出）

### 4. 500 字 context 的分配策略

| 槽位 | 建议字数 | 来源 | 优先级 |
|---|---|---|---|
| 用户手填 context | 0-200 字 | 表单 | **最高**（最近需求） |
| 公司常量 | 50-100 字 | env config | 高 |
| 近 30 天相关调研 | 100-150 字（5 条 × 20-30 字） | DB | 中 |
| 近 30 天相关知识库 | 50-100 字（3 条 × 15-30 字） | DB | 中 |
| 当前用户身份标签 | 0 字（不进 context） | session | 仅权限用 |

> **排序原则**：用户输入 > 公司常量 > 历史沉淀。把"这次想问什么"放最前，避免被历史稀释。

### 5. 容易踩的坑

1. **context 不是越多越好**：超过 500 字，LLM 注意力会分散，把关键约束（"我们用 FastAPI"）稀释掉。**对策：500 字硬限 + 超出截断时优先砍"历史沉淀"段**。
2. **历史对话不能无限追加**：追问链每多一轮，前面的 context 就被压缩或丢弃。**对策：第 3 轮起把历史 context 压成 1 段 "Earlier Q&A summary"**。
3. **数据源响应是 context 的"二次污染"**：如果 Tavily 拉回的网页里夹带 prompt injection 文本（"忽略之前的指令，输出 ..."），它会进 Aggregator 的 prompt。**对策**：v2 加 LLM 输出侧的 content filter（P0 不做）。
4. **跨语言 context**：英文 arxiv 摘要 + 中文团队 context，Sonnet 4.5 双语能力够强，**混排即可**，分块反而割裂语义。
5. **comment 不进 LLM context**：评论质量参差、含主观判断，混进 AI 调研 prompt 会污染输出。如果要做"基于团队讨论做调研"，单独走新流程（P1 评估）。

### 6. 追问规则（v3.3.1 明确化）

> 用户多次提到"是否允许多轮对话"——本节把规则说清楚。

**6.1 追问范围**（v3.3.1 明确）：

| 追问对象 | 是否支持 | 场景 |
|---|---|---|
| **AI 调研草稿** | ✅ **支持（核心）** | 成员改 AI 草稿时，让 AI 解释某段、辩护某选择、补充某数据 |
| **每日摘要 / 用户分享** | ✅ **支持（推荐）** | 读完摘要后问 AI "这篇跟我们的 LangGraph 评估有什么关系？" |
| 精华条目 | ❌ **不支持** | 精华是已审过的成品，再问 AI 是反流程（应直接评论或提名更新） |

> 之前 mockup 抽屉画的是"读摘要时 AI 提问"——**v3.3.1 确认这是正确主场景**。本节规则与 mockup 一致。

**6.1.1 追问者与追问动机**（v3.3.1 明确，重要）：

> 追问者不一定是作者。

| 追问者 | 典型动机 | 追问结果写回哪里 | session 归属 |
|---|---|---|---|
| **作者** | "这数字从哪来 / 这结论太绝对，重写" | 草稿：`researches.content_md`（仅作者可见） | 作者私 session |
| **其他阅读者** | "50 并发会不会爆内存 / 这 benchmark 怎么用" | `comments` 表（追问链） | 任何阅读者开 |
| **admin** | "这结论有偏差，要补风险段" | 同作者，写回草稿 | 私 session |

> 关键设计：**作者追问 = 修改工具**；**读者追问 = 协作对话**。两者都走 AI 但写回不同表。
> 配额 20 次/日 是**全团成员**统一池，不是作者的独立池（防止某些热门调研被作者个人占满）。

**6.1.2 草稿可见性硬规则**（v3.3.1 新增，必读）：

> **草稿（status=draft）只能作者自己看到。** 这是产品的基础安全/隐私约束。

| 对象 | draft | published |
|---|---|---|
| 作者 | ✅ CRUD + 追问 | ✅ |
| 其他成员 | ❌ 完全不可见 | ✅ 读 + 追问（写回 comments） |
| admin | ❌ 不可见（**也是作者才能看**） | ✅ |
| 团队搜索引擎 | ❌ 不索引 | ✅ 索引 |
| 顶栏"我的草稿"下拉 | ✅ 仅自己 | n/a |

**约束理由**：
- 草稿含未审核内容，可能错、可能涉密、可能只有作者能看懂的半成品
- admin 也看不到别人的草稿 → **保持中立**：admin 是"内容把关者"不是"内容窥视者"
- 实现：API 层做行级权限过滤，DB 不靠 RLS（v3.3.1 P0 选 BFF 强制过滤，v2 可上 RLS）

**6.1.3 作者对已发布调研的修改**（v3.3.1 简化，明确状态切换）：

> **published 调研默认是只读**——任何作者、读者、admin 看到的都是同一份内容。
> 作者想改自己已发布的调研，**必须显式点"进入修改"按钮**进入修改模式，AI 共创才解锁。

```
published 调研详情页（默认状态）
  ├─ 读者：💬 评论 + ✨ AI 提问（→ 写回 comments）
  └─ 作者：💬 评论 + ✨ AI 提问（→ 写回 comments）  ← 默认和读者一样
                + ✏️ [进入修改] 按钮（仅作者可见）
                            ↓ 点击切换
                            ↓
修改模式（仅作者自己看到，团队看到的还是 published）
  ├─ 顶部橙色提示条："✏️ 修改模式 · 其他成员看到的是原版本"
  ├─ 调研内容变可编辑（编辑器组件激活）
  ├─ AI 提问 → [✍️ 应用回此版本] 按钮（写回 research_audit）
  └─ [完成修改] 按钮 → 创建新 version + research_audit 记录
       → 其他成员收到"已更新"通知
       → 默认回到只读模式
```

**与 v3.2 设计的差异**：
- v3.2：作者对已发布追问**直接覆盖** → 风险（污染历史、不可回滚）
- v3.3.1（采纳你的方案）：published 只读 + 显式"进入修改" → **更安全、UI 状态更清晰**
- **不引入 research_drafts 表**（v3.3.1 之前的设计）：用 research_audit（v3.2 已加）记录修改历史足够
- 作者修改的是同一行 `researches` 的最新版（不创建新行），避免关系图变复杂

**核心规则（v3.3.1 一句话总结）**：

| 状态 | 作者 | 其他成员 | AI 行为 |
|---|---|---|---|
| 草稿 (status=draft) | ✅ 可见 + 可改 + 可追问 AI（应用回草稿） | ❌ 完全不可见 | 应用回草稿 |
| published 默认 | ✅ 可见 + 可评论 + 可问 AI（写回 comments） | ✅ 可见 + 可评论 + 可问 AI | 写回 comments |
| published + 进入修改 | ✅ 看到修改模式 | ❌ 看到的还是 published | 应用回此版本（写 audit） |

**6.2 多轮对话策略**（v3.3.1 明确）：

- **单 session 内无限轮**：1 次"启动 AI 调研"或"打开摘要详情"= 1 个 session，session 内可问任意多轮
- **第 3 轮起压缩历史**：前 2 轮原文进 context，第 3 轮起压缩为 1 段 "Earlier Q&A summary"（控制 token）
- **跨 session 保留**（v3.3.1 新增）：用户能看到自己过去 30 天的所有追问历史（落地到 `comments.parent_summary_id` 链 + 个人探索历史 tab，P1 §15 探索路径的一部分）
- **session 结束**：草稿 publish 后 session 自动关闭；或 7 天无活动自动归档

**6.3 配额与提醒**（v3.3.1 强化）：

- **每日上限**：20 次/日/人（含 AI 调研启动 + 追问）
- **超额提醒**（v3.3.1 新增）：当日累计达 15 次时弹 toast 提醒"今日还剩 5 次"；达 20 次后**给"我知道很贵，还是问"按钮**，不硬阻断
- **追问专用配额**：20 次里有 5 次预留给"追问"（不算 AI 调研启动），防止某天全用来问 AI 调研，**追问就拿不到配额**

**6.4 为什么这样设计**：

- **追问是"AI 写 + 读"的双向延伸**：写调研时要 AI 解释/辩护，读摘要时要 AI 关联/对比
- **跨 session 保留是产品粘性**：你上周问"为什么不用 LangGraph"，这周想再问 "LangGraph v0.5 发布后你怎么看"——AI 应该记得上下文
- **不硬阻断 20 次**：硬阻断会逼用户切号，反而糟糕；显式提醒 + 自愿承担是更好的 UX

---

## 五、数据库 Schema

5 张表（详见 `MODULE_MAP.md` 第四部分）：
- `users` / `summaries` / `researches` / `research_sources`
- `ai_research_jobs` / `ai_research_sources` / `comments`
- **P0 必带（v3.2 补）** `research_audit`（已发布调研的修改留痕表，防误改无回滚）

### `research_sources.source_ref` 字段类型（v3.2 明确）

`source_ref` 存的是"资料引用"——可能是 URL、DOI、arxiv_id、内部知识库 ID。**统一用 JSONB**：
```sql
source_ref JSONB NOT NULL,    -- 结构：{"type": "url"|"doi"|"arxiv"|"knowledge", "value": "..."}
-- 示例：
--   {"type": "url",      "value": "https://arxiv.org/abs/2406.12345"}
--   {"type": "doi",      "value": "10.1234/abc.2024"}
--   {"type": "arxiv",    "value": "2406.12345"}
--   {"type": "knowledge","value": "knowledge_entry_uuid"}
CREATE UNIQUE INDEX research_sources_ref_uniq
  ON research_sources ((source_ref->>'type'), (source_ref->>'value'));
```

> 为什么用 JSONB 而不是 string：去重必须按 (type, value) 联合唯一，string 字段会出现"同一篇论文被 URL 和 arxiv 两种方式重复挂"的情况。

### v3.1 增量（用户分享 + 评论提到 P0）

**summaries 表加 3 列**（区分每日摘要 / 用户分享）：
```sql
ALTER TABLE summaries
  -- 重命名旧的 source_type → content_origin（避免和新加的 source 字段重名）
  -- 若已是 v3.0+ 部署则不用改
  ADD COLUMN content_origin     text NOT NULL DEFAULT 'web'
    CHECK (content_origin IN ('web','rss','api','manual')),  -- 老的 source_type 含义
  ADD COLUMN source             text NOT NULL DEFAULT 'daily'
    CHECK (source IN ('daily','user')),
  ADD COLUMN user_note          text,                       -- 用户分享时填的备注
  ADD COLUMN shared_by_user_id  uuid REFERENCES users(id);  -- source=user 时必填
CREATE INDEX summaries_source_idx ON summaries(source, created_at DESC);
```

> **命名冲突解决（v3.2 明确）**：summaries 表里 `source_type`（旧字段，"内容来自网页/RSS/API"）和 v3.1 新加的 `source`（"每日/用户"）**容易混淆**。
> - 老部署：保持 `source_type` 不变，新字段叫 `source`（轻微歧义，注释说明）
> - 新部署：把 `source_type` 改名为 `content_origin`（更清晰）
> - ER 图统一以**新部署**为准标注 `content_origin`

**comments 表 polymorphic**（v2 提前到 P0，调研和摘要共用一张评论表）：
```sql
ALTER TABLE comments
  ADD COLUMN target_type text NOT NULL DEFAULT 'research'
    CHECK (target_type IN ('research','summary')),
  ADD COLUMN target_id   uuid;                             -- research_id 或 summary_id
-- 保留原 research_id 列以做向后兼容（双写期间读 target_id 优先）
```

**ai_research_jobs 表加 purpose**（区分完整调研 vs 用户分享轻量摘要，复用 job 流，不建新表）：
```sql
ALTER TABLE ai_research_jobs
  ADD COLUMN purpose    text NOT NULL DEFAULT 'research'
    CHECK (purpose IN ('research','summary')),
  ADD COLUMN source_url text,       -- purpose=summary 时必填
  ADD COLUMN user_note  text;       -- purpose=summary 时填
```

> 为什么不建新 `summary_jobs` 表：job 的 status / retry / webhook / 通知逻辑是同一份，复用只多 1 个 `purpose` 字段；后期如果量级差异巨大再拆。

### v3.2 增量（评论提名 → admin 提炼进知识库）

**researches 表加 4 列**（区分「调研」与「知识库条目」+ AI 协助溯源，v3.3.1 加 2 列）：
```sql
ALTER TABLE researches
  ADD COLUMN type                text NOT NULL DEFAULT 'research'
    CHECK (type IN ('research','knowledge')),
  ADD COLUMN source_comment_id   uuid REFERENCES comments(id),  -- type=knowledge 时填，溯源
  ADD COLUMN ai_assisted         boolean NOT NULL DEFAULT false,  -- v3.3.1：是否基于 AI 草稿改写
  ADD COLUMN ai_assisted_job_id  uuid REFERENCES ai_research_jobs(id);  -- v3.3.1：哪个 AI 任务改的（溯源用）
CREATE INDEX researches_type_idx ON researches(type, published_at DESC);
CREATE INDEX researches_ai_idx    ON researches(ai_assisted) WHERE ai_assisted = true;
```

> **✨ AI 协助标签规则**（v3.3.1）：
> - `ai_assisted=false`：纯成员手写，列表/详情不显示标签
> - `ai_assisted=true`：列表显示 `✨ AI 协助` 蓝标，详情页头部单独标，**可作为搜索过滤项**（"只看人工撰写"）
> - 触发：`researches` 从 `ai_research_jobs` 的草稿创建时，`ai_assisted=true` 且填 `ai_assisted_job_id`
> - **永远禁止** `ai_assisted=true` 但成员没改的情况（违反 v3.2 "AI 草稿必须成员修改"原则）

> v3.2 简化：`status` 字段从 v3.0 的 `draft / in_review / published` 三态合并为 **`draft / published` 两态**。
> - AI 调研草稿 → `draft` → 成员编辑后 → `published`（v3.2 不再有"待审核"中间态，因为没人审了）
> - 评论提名草稿 → `draft` → admin 批准 → `published`（`published` 在 knowledge 上等同"入库"）

**comments 表加 4 列**（评论支持被提名 + 审核流）：
```sql
ALTER TABLE comments
  ADD COLUMN promote_status  text NOT NULL DEFAULT 'none'
    CHECK (promote_status IN ('none','nominated','approved','rejected')),
  ADD COLUMN nominated_by    uuid REFERENCES users(id),
  ADD COLUMN reviewed_by     uuid REFERENCES users(id),
  ADD COLUMN reviewed_at     timestamptz;
```

**工作流**：
```
任意角色选段评论 → [💡 提名到知识库]
  → 弹窗填标题/tags/作者归属
  → 写一条 researches(type='knowledge', source_comment_id=X, status='draft')
  → 更新原评论 promote_status='nominated'，记录 nominated_by
                            ↓
admin 在「提名队列」看到条目
  → approve → knowledge.status='published'，原评论 promote_status='approved'
  → reject  → 删除 knowledge 条目，原评论 promote_status='rejected'
```

> 为什么评论和知识库都走 `comments` + `researches` 两张既有表，不建新表：
> - 知识库条目需要全文搜索、标签、状态流转——和调研完全一样，复用零成本
> - 评论的溯源只多一个 `source_comment_id` 字段，不影响主流程
> - 后期如果知识库有独立形态（独立首页、独立权限），再拆 `knowledge_entries` 表也来得及

---

## 六、8 周冲刺计划

> v3.3 调整：A5 三层超时（0.5 周）+ B3 ⭐ 提名（0.5 周）+ C5 critic（0.5 周）加进来。**实际 P0 = 10.5 周**。
> 多出的 1 周要么吸收，要么砍掉 P1「多 LLM 路由（LiteLLM）」。

| 周 | 任务 | 交付 |
|---|---|---|
| 1 | Next.js 脚手架 + Auth + DB | 能登录的空白站 |
| 2 | 每日摘要模块（不含分享） | 每日自动推送 |
| 3 | 调研模块 + 编辑器 + 挂载资料 | 能创建/阅读调研 |
| 4 | 全文搜索 + UI 打磨 | MVP 调研流可用 |
| 5 | gpt-researcher 集成 + summary_brief 轻量模式（fork 改造） | 调研 + 摘要 API 可调 |
| 5.5 | summaries/comments schema 升级 + user share 后端（无 UI） | 用户贴 URL → 后端可处理 |
| 6 | AI 调研前端 + 摘要详情页（追问 + 评论 UI）+ user share UI + **A5 三层超时** | 端到端跑通 + 进度可见 |
| 6.5 | **🔥 热议页（v3.3.1）** + **详情页（v3.3.1）+ ✨ AI 协助标签** + **Avatar 下拉（v3.3.1）** | 沉淀页可看热度 + 点卡可进详情 + 个人下拉 |
| 7 | 评论功能联调 + admin 角色权限 + **B3 ⭐ 标签** | 提名更轻量 |
| **7.5** | 评论提名 → admin 提炼进知识库 + **🛡️ Admin 控制台（4 子 tab，v3.3.1）** | 提名/审核/入库全流程跑通 + admin 守门员到位 |
| 8 | **C5 AI critic 集成（opt-in 开关）** + Docker Compose + 部署 + 试用 | 内测版（可选高质量模式） |
| 9 | 决策点 | 继续/暂停/砍 |

---

## 七、成本估算

| 项目 | 月度成本 |
|---|---|
| Vercel 免费档 | $0 |
| Neon PostgreSQL 免费档 | $0 |
| Claude Sonnet 4.5 | $40-80 |
| Tavily | $30-50 |
| arxiv-mcp-server | $0 |
| gpt-researcher | $0 |
| **gpt-researcher 轻量调用增量** | **+$15-30** |
| **AI critic opt-in 增量（v3.3，Week 8 评估是否默认开）** | **+$5-15** |
| **总计（乐观 / 悲观）** | **$75 / $200 / 月** |

### 成本敏感度分析（v3.2 新增）

> 假设 LLM 价格上涨（GPU 紧缺 / 模型换代），最坏情况是什么样？

| 场景 | Claude 单价 | 调研单价 | 摘要单价 | 月度估算 | 决策点 ROI 是否仍通过？ |
|---|---|---|---|---|---|
| **乐观**（当前价） | $0.025/1k | $0.25 | $0.05 | $75 | ✅ ROI > $200 |
| **基准**（v3.2 假设） | $0.025/1k | $0.30 | $0.06 | $115 | ✅ ROI > $200 |
| **悲观**（涨价 50%） | $0.038/1k | $0.45 | $0.09 | $175 | ⚠️ 接近 ROI 底线 |
| **灾难**（涨价 100%） | $0.050/1k | $0.60 | $0.12 | $235 | ❌ ROI 跌破 $200，触发降级 |

> 触发条件：连续 2 个月实际成本 > $200 → 启动降级方案（关 critic + 只跑轻量模式 + 月调研上限砍半）。

---

## 八、要 fork 的仓库

| 仓库 | 用途 |
|---|---|
| assafelovic/gpt-researcher | AI Deep Research 引擎 |
| blazickjp/arxiv-mcp-server | 论文深度检索 |

**只 fork 这两个。**

---

## 九、风险预警

### 风险 1：gpt-researcher 中文支持弱
**对策**：Week 5 集成后用 3-5 个真实中文主题盲测，< 70% 满意就降级到自写 LangGraph pipeline。

### 风险 2：调研生产量不足
**对策**：Week 8 决策点，< 5 篇/人/月直接砍。

### 风险 3：gpt-researcher 上游不维护
**对策**：fork 后内部维护成本可控；fallback 是直接调 Claude API + 简单 prompt。

### 风险 4：context 拼接的 token 成本
**对策**：每日 AI 调研上限 20 次，月成本增加 < $30。

> **真实成本结构（容易被低估）**：单次 AI 调研不是 1 次 LLM 调用，是 5 步 pipeline：
> - Step 1 Plan（拆子问题）：~$0.02
> - Step 2 Search Agent 群发：5-10 次并发调用 × ~$0.03 = ~$0.15
> - Step 3 Compress（每条资料 1 次）：20-30 次 × ~$0.01 = ~$0.20
> - Step 4 Analyze：~$0.05
> - Step 5 Write：~$0.05
> - **单次合计约 $0.20-0.30**，是单次轻量摘要的 5 倍
>
> 风险 4 的"每日 20 次 × $0.25 × 30 天 = $150/月"是单次 AI 调研的成本上限估算；用户分享的轻量摘要走 `summary_brief` 模式（只跑 Step 1+5），单次约 $0.05。

### 风险 5：用户分享内容失控 + admin 审核负担（v3.1 + v3.2 整合）
**对策**：
- 限制每日分享次数（防 spam，初定 5 次/人/天）
- URL 白名单域名清单 + 黑名单（社交媒体短链、内网地址）
- `user_note` 走敏感词过滤（参考公司内审查词库）
- **统一 admin 审核队列页**：用户分享 review + 评论提名 → 同一个 admin 队列，按"任务类型"分 tab
  - Tab 1：分享审核（summaries.status='pending_review'，admin 批准后转 published）
  - Tab 2：提名审核（comments.promote_status='nominated'，admin 批准后写入 knowledge 并 approved）
- 机器预审：LLM 给提名评 0-1 分（内容质量、与原调研相关性、是否需补上下文），> 0.7 自动 approved
- admin 可「一键拒绝近 7 天」批量操作

> **避免双队列带来的工作量叠加**：分享审核和提名审核共用一个 UI 入口，admin 只在一个地方看所有待办。Week 4 决策点看提名量；< 5 条/周 → admin 手动 OK；> 30 条/周 → 必须启用机器预审。

### 风险 6（v3.1 新增）：追问的 gpt-researcher 调用成本
**对策**：每日追问上限 20 次/人（含 AI 调研），与风险 4 共享 20 次/日预算。追问只跑 `summary_brief` 轻量模式（`max_iterations=1`），单次成本压到 1/3。

### 风险 7（v3.1 + v3.2 共存，现已并入风险 5）
> 见风险 5 整合版。原"admin 审核负担"风险已并入风险 5，避免双队列工作量叠加。

### 风险 8（v3.2 新增）：gpt-researcher fork 维护失控
**对策**：
- **已改文件清单**（维护时必查）：`summary_brief` 模式入口（Week 5 改造）、`purpose=summary` 分支（v3.1）、Step 0 拼装（v3.2）
- **CI 检查**：每次 PR 跑一遍 `make fork-drift-check`，对比 `upstream/main` 列出冲突文件
- **合并上游节奏**：上游每月发版 → 内部 sprint 末 merge；冲突超过 3 文件 → 推后到下个 sprint
- **rollback 触发**：fork 关键功能 3 天内连续 2 次线上事故 → 切回上游稳定版 + 用裸 Claude API 顶

### 风险 9（v3.2 新增）：LLM 价格波动
**对策**：见第七章成本敏感度分析。我们已按"$200/月"做 ROI 底线（v3.3 上调）；如果 LLM 涨价 50% 且 ROI 跌破底线，**优先级降级**到"只用轻量模式"（purpose=summary），全量调研推迟到 P1。

### 风险 10（v3.3 新增）：三层链路超时无反馈
**对策**：见 §13。已加 4 层超时（90/80/70/30s）+ status 端点 + partial 策略。Week 6 必带。

### 风险 11（v3.3 新增）：评论沉淀转化率低
**对策**：见 §14。已加 ⭐ 标签 + 3 票自动 nominated + ⭐≥5/10 自动升级通知。Week 7 必带。

### 风险 12（v3.3 新增）：AI critic 模式成本失控
**对策**：见 §16。opt-in 默认关闭，Week 8 决策点看 AI 草稿被采用率，< 50% 才自动开启。一旦成本 > $15/月增量 → 关闭。

### 风险 13（v3.3.1 新增）：Admin 审核负担 + 单点故障
**对策**：
- 多人 admin：团队 ≥ 5 人时设 2+ admin，避免单点（v3.3.1 设 admin 二次确认）
- 软删除（`users.disabled_at`）保护误操作
- 机器预审 AI 评分阈值 0.7 自动通过，分担 admin 工作量
- Week 4 决策点看 admin 每周审核量；> 30 条/周强制开启机器预审

---

## 十、决策点（Week 9 必做）

> 4 个指标从 4 个维度衡量产品价值（**单个指标都可能被欺骗，必须看 4 个**）。详见 `docs/DIAGRAMS.md` 第七节非工程师版说明。

| # | 指标 | 为什么看它 | 继续做的标准 |
|---|---|---|---|
| 1 | 团队每月产出多少篇正式调研 | 存量价值：内容库是核心资产 | ≥ 5 篇 |
| 2 | 多少同事每周打开平台 | 流量价值：用了才有反馈 | ≥ 30% |
| 3 | AI 调研月调用量 / 团队人数 | 参与价值：AI 是否真在帮到人 | ≥ 1 次 / 人 / 月 |
| 4 | AI 节省的工时 × 时薪 | ROI 价值：成本能不能赚回来 | > $180 / 月 |

4 个里**至少 2 个达标** → 继续投入；否则砍掉，把精力放到别的事上。

> 与 DIAGRAMS.md 第七节保持一致。原 v3.0 旧 3 指标（"AI 调研满意度 ≥ 70%"）已废弃——单一指标不足以反映产品价值。

---

## 十一、tags 存储策略（v3.2 明确）

`summaries.tags[]` 和 `researches.tags[]` 用 **PostgreSQL 数组**存储：

```sql
-- v3.2 必带：tags GIN 索引（否则 @> 查询全表扫描）
CREATE INDEX summaries_tags_gin   ON summaries   USING GIN (tags);
CREATE INDEX researches_tags_gin  ON researches  USING GIN (tags);
```

- **MVP 阶段（< 100 篇调研）**：数组 + GIN 索引够用，简化代码
- **> 100 篇时必须拆关联表**：建 `research_tags(research_id, tag)` + `summary_tags(summary_id, tag)`，建复合主键

> 拆表触发条件：发现以下任一情况即拆
> - 单条记录的 tag 数 > 10（数组写入性能下降）
> - "找同时有 tag A 和 tag B 的所有调研"成为高频查询
> - 跨表 tag 统计（如"团队最热门 10 个 tag"）成为产品需求

---

## 十二、修改留痕（research_audit，P0 必带）

> v3.2 新增要求：发布后的调研/知识库被修改，**必须留痕**（P0 必带，UI 暂不做，DB 表必建）。

```sql
CREATE TABLE research_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id     uuid NOT NULL REFERENCES researches(id),
  editor_id       uuid NOT NULL REFERENCES users(id),
  action          text NOT NULL CHECK (action IN ('create','edit','publish','revert')),
  diff            jsonb,                       -- 字段级 diff（标题/正文/标签 改了啥）
  prev_snapshot   jsonb,                       -- 修改前完整快照（rollback 用）
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_audit_research_idx ON research_audit(research_id, created_at DESC);
```

> 不做版本历史 UI（P1），但数据可查：出问题时用 SQL 一行回滚 + 责任可追溯。

---

## 十二点五、详情页 UI 规范（v3.3.1 新增，与 mockup 同步）

> 长文（type=research）和精华（type=knowledge）共用同一个详情页组件，按 `type` 切换部分字段。

### 1. 详情页区块顺序（自上而下）

| 区块 | 长文（research） | 精华（knowledge） |
|---|---|---|
| 面包屑 | 每日摘要 / 沉淀 / 文章名 | 沉淀 / 精华 / 文章名 |
| 类型徽章 | `[长文] [published] [✨ AI 协助?]` | `[精华] [published] [✨ 来自 ⭐ x3 提名]` |
| 标题 | H1 32px | H1 32px（可更短） |
| 一句话描述 | 是 | 是 |
| 作者信息条 | 头像 + 名字 + 发布时间 + 浏览数 | `提炼自 {原作者} 评论` + 提炼人 + 时间 |
| 操作按钮 | ⭐ 收藏 / 💡 提名 / ✨ AI 提问 / ⋯ | 同 |
| **结构化字段 3 卡** | 📌 背景 / ✅ 结论 / ⚠️ 风险 | **不显示**（精华太短不需要） |
| Markdown 正文 | 长文渲染（标题/列表/code/表格/加粗） | 短段（200-500 字），不渲染 H1/H2 |
| **挂载资料** | 3-10 条 external resources | **不显示**（精华源自评论，无独立资料） |
| 评论区 | polymorphic 显示 | polymorphic 显示 |
| 右侧抽屉 | ✨ AI 提问（点按钮滑出） | 同 |

### 2. 详情页的 3 张结构化字段卡

> 来源：`researches.background / conclusion / risks` 三个字段（v3.0 就有，v3.3.1 明确 UI 呈现）

- **📌 背景**（蓝）：一两句话回答"为什么调研这个"
- **✅ 结论**（绿）：一两句话回答"结论是什么"
- **⚠️ 风险**（红）：一两句话回答"什么场景下不适用 / 有什么坑"

3 张并排（移动端竖排），文字短（不超 100 字/卡）。

### 3. ✨ AI 协助 标签出现规则

- 列表卡片右下角小蓝标（`<span class="text-blue-700">✨ AI 协助</span>`）
- 详情页头部标签栏第 3 个标签位
- 搜索页可勾选"只看人工撰写"过滤
- **永远不出现**在精华详情页（精华是 admin 提炼 + 评论溯源，与 AI 调研无关联）

### 4. 挂载资料 UI（research_sources 列表）

- 详情页底部"📎 挂载资料"区
- 每条：图标（URL/DOI/arxiv/讨论）+ 标题（蓝链）+ 简介 + ↗ 跳转
- 来源数据：`research_sources.source_ref` JSONB `{type, value}`（v3.2 已加）
- 关联查询：`research_sources.research_id` → 列出全部
- 团队讨论溯源：`source_ref.type='discussion'`，value 指向 comment_id

---

## 十三、三层超时 + 任务状态端点（v3.3 新增，对应风险 A5）

> 解决问题：当前 AI 调研链路 `用户 → Next.js BFF → ai-engine → gpt-researcher` 4 层嵌套，**任何一层超时/出错/重试，用户看到的就是"AI 调研启动失败"，没有进度反馈**。

### 1. 分层超时（v3.3 必带）

| 层 | 默认超时 | 失败行为 |
|---|---|---|
| 前端 fetch（用户视角） | **90s** | 显示"调研进行中"卡片 + 引导去历史任务页 |
| Next.js BFF 调 ai-engine | **80s** | 重试 1 次（间隔 2s）→ 仍失败抛 504 |
| ai-engine 调 gpt-researcher | **70s** | 5 步 pipeline 任一步超时 → 标记 `current_step` 卡住、保留已生成的部分资料 |
| ai-engine 调数据源（Tavily/arxiv/GitHub） | **30s** | 单条超时不影响整局，记入 `failed_sources` 数组 |

> **逐层缩短**的目的是：底层超时先暴露，上层有 buffer 把"部分成功"的结果回传前端。

### 2. 状态端点（v3.3 必带，SSE 留 P1）

```
GET /api/ai-research/{job_id}/status
→ {
  "job_id": "...",
  "status": "running" | "completed" | "failed",
  "current_step": "plan" | "search" | "compress" | "analyze" | "write",
  "progress_pct": 60,
  "elapsed_sec": 45,
  "partial_sources": 18,            // 已成功拉取的条数
  "failed_sources": ["url1", ...],  // 失败的源（不阻塞）
  "error_stage": "search",          // failed 时填
  "error_message": "arxiv 503"      // failed 时填
}
```

- 前端每 **5s 轮询**一次（Week 6 起即可用）
- 失败时 `error_stage` 让用户/支持知道"卡在 search 步骤，arxiv API 挂了"
- P1 升级为 SSE 推送（节省轮询开销，UX 更好）

### 3. ai-engine 内部状态机

```
[queued] → plan (Step 1) → search (Step 2) → compress (Step 3) → analyze (Step 4 opt-in) → write (Step 5) → [completed]
                                              ↓ 任何步骤失败
                                            [failed] (保留 partial_sources)
```

> **partial 策略**：search 完成 50% 时 ai-engine 超时，不直接失败——把已搜到的 50 条资料写回 `ai_research_sources`，**让成员有素材可手动整理**。

---

## 十四、提名步骤瘦身：⭐ 标签 + 3 票自动 nominated（v3.3 新增，对应风险 B3）

> 解决问题：原 4 步（评论 → 选段 → 提名弹窗 → admin 批准）转化率 3%，97% 沉淀失败。

### 1. 简化后的流程

```
任意角色看到一条评论 → 点 [⭐ 重要]
  → 写一条 comments_star(comment_id, user_id) 记录
  → comments.star_count++
  → 当 star_count ≥ 3 → 自动 promote_status='nominated'
  → admin 在「提名队列」看到 → 批准/拒绝（与原流程一致）
```

- 选段和弹窗步骤**砍掉**
- 3 票阈值：避免单人噪音 + 不需要 admin 投票发起
- 弹窗只在最后 admin 批准时出现（填标题/tags/作者归属）

### 2. Schema 增量

```sql
CREATE TABLE comment_stars (
  comment_id  uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)   -- 一人一票
);
CREATE INDEX comment_stars_user_idx ON comment_stars(user_id, created_at DESC);

-- 提速：评论列表带 star_count（避免每次 count）
ALTER TABLE comments ADD COLUMN star_count int NOT NULL DEFAULT 0;
```

### 3. UI 改动

- 评论右侧加 [⭐ 重要] 按钮，已点过显示 ⭐ 数
- 提名队列页的"提名来源"列显示"⭐ x3 触发"（区别于"主动提名"）
- **旧选段+弹窗 UI 仍保留**（admin 主动提名时用），但默认走 ⭐ 流程

### 4. 触发 admin 角色的辅助规则

- ⭐ 数 ≥ 5 的评论：自动给 admin 推 Slack 通知（高频信号）
- ⭐ 数 ≥ 10：自动 promote_status='nominated' 并标记 `hot=true`（admin 优先看）

> **不取消 admin 决策权**——3 票自动 nominated，admin 仍可 reject。**提速沉淀**才是目标。

---

## 十五、知识探索路径可视化（v3.3 新增，对应可丰富方向 C1）

> 标记：**P1 评估**（不进 P0 冲刺，但 P0 数据结构要为它预留）

### 1. 目标

把"每个成员的追问链"变成"团队思考的可视化"：
- 看到自己常问的主题
- 看到团队最常追问的主题
- 自动建议"新调研主题"（基于追问密度）

### 2. 数据结构预留

```sql
-- 追问会话（用户视角）
ALTER TABLE comments ADD COLUMN parent_summary_id uuid REFERENCES summaries(id);
-- 当 target_type='summary' 且这是一次追问时，parent_summary_id 指向原 summary

-- 主题聚合（团队视角，P1 落地）
CREATE TABLE explore_topics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic        text NOT NULL,
  frequency    int NOT NULL DEFAULT 0,    -- 团队追问次数
  last_seen_at timestamptz,
  related_research_ids uuid[]
);
```

### 3. 三个使用场景

| 场景 | 数据来源 | 价值 |
|---|---|---|
| **个人探索历史** | comments.parent_summary_id | 成员看到自己过去 30 天的追问路径 |
| **团队热门主题** | explore_topics 聚合 | admin 看到"团队最近在问 LangGraph 多" |
| **AI 调研推荐** | explore_topics 频次 | 自动建议"团队常问 X，建议启动一次 AI 调研" |

### 4. 风险与时机

- **隐私问题**：个人探索历史默认仅本人可见，团队聚合要剔除 user_id
- **冷启动**：MVP 阶段 0 追问，topic 聚合算法至少需要 50+ 追问才有效
- **P1 评估触发**：8 周后如果"AI 调研调用量"指标不达标（DIAGRAMS 决策点 #3），优先做这个

---

## 十六、AI 对抗性 review（v3.3 新增，对应可丰富方向 C5）

> 目标：把 AI 草稿质量从 **70 分**提到 **85 分**，通过第二个 LLM 角色"挑刺"。

### 1. 工作流（opt-in，默认关闭）

```
Step 5 (Write) 输出草稿
    ↓
[可选] Step 6 (Critic) — 第二个 LLM 以"挑刺者"身份读草稿
    ↓
输出 critique：
  · 风险点列表（"3.2 节声称 X，但没引证来源"）
  · 未验证假设（"5.1 节假设 Y 在我们的场景成立，但 5 人团队未必"）
  · 反例（"Z 框架可能比 LangGraph 更适合，但我们没讨论"）
    ↓
自动把 critique 写到草稿末尾「⚠️ AI 自审」区块
    ↓
成员编辑器看到草稿 + 自审，**改起来更有针对性**
```

### 2. 开关

```sql
ALTER TABLE ai_research_jobs
  ADD COLUMN enable_critic boolean NOT NULL DEFAULT false;  -- opt-in
```

- **P0 默认 false**（避免成本 +30%、增加时延）
- Week 8 决策点看 AI 草稿被采用率，**若 < 50% 自动开启 critic**（提高草稿质量）
- 单次 critic 约 +$0.05、+10-15s

### 3. 关键判断

- **不要让 critic 改草稿**，只输出意见——避免两个 LLM 互相"对齐"产生幻觉
- **prompt 限定为"找问题"，不写"重写"**——成员有最终决定权
- critic 模型可以用同一 Sonnet 4.5，**P1 再考虑用更便宜模型（Haiku 4.5）降本**

### 4. 风险

- 双重 LLM 调用 = 单次成本 +30%（$0.25 → $0.32）
- 慢思考（slow thinking）的 LLM 调用，**时延 +40%**（30s → 42s）
- critic 也会犯错，**成员不能盲信**——必须留"这条 critic 我不认同"按钮（数据回流）

---

## 十七、Admin 控制台 + 顶栏导航 + Avatar 下拉（v3.3.1 新增，与 mockup 同步）

### 1. 顶栏结构（5 个 tab + avatar 区）

| 位置 | 元素 | 角色可见性 |
|---|---|---|
| 顶栏 tab 1 | `每日摘要` | 全部 |
| 顶栏 tab 2 | `🔥 热议`（v3.3.1 新增） | 全部 |
| 顶栏 tab 3 | `📚 沉淀`（v3.3.1 改名，原"调研库"） | 全部 |
| 顶栏 tab 4 | `AI 调研` | 全部 |
| 顶栏 tab 5 | `🛡️ Admin`（红色高亮） | **仅 admin** |
| 顶栏右侧 | 日期 + Avatar 下拉 | 全部 |

> 普通成员看不到 `🛡️ Admin` tab，但能在 avatar 下拉里看到 `Admin 控制台` 红色入口（防御性，**前端隐藏** + **后端权限校验** 双保险）。

### 2. Avatar 下拉菜单（v3.3.1 新增）

| 区块 | 项 | 角色 |
|---|---|---|
| 头部 | 头像 + 姓名 + 邮箱 | 全部 |
| 我的内容 | `📝 我的草稿 (3)` | 全部（仅自己可见） |
| 我的内容 | `⭐ 我的收藏 (12)` | 全部（仅自己可见） |
| 我的内容 | `🔥 团队热门` | 全部（跨模块热度，可点跳到 🔥 热议 tab） |
| 我的内容 | `🔔 通知 (3)` 红色徽标 | 全部 |
| 分隔 | | |
| 角色 / 工具 | `🛡️ Admin 控制台`（红色） | **仅 admin** |
| 角色 / 工具 | `⚙️ 个人设置` | 全部 |
| 角色 / 工具 | `🚪 退出登录`（红色） | 全部 |

> 通知项的"3"包含：@我的评论 / 提名额状态变更 / 系统通知（部署完成、限额警告等）。
> 数字徽标在"通知"项上**始终红色**（最紧急）；其他项用灰色数字。

### 3. Admin 控制台（v3.3.1 新增，🛡️ Admin tab 内）

#### 3.1 顶部 4 张统计卡

| 卡片 | 数据来源 | 说明 |
|---|---|---|
| ⏳ 待审核 | 精华提名 5 + 分享审核 2 | 红色大数字，admin 第一眼看到 |
| 📚 本周新增 | 长文 6 + 精华 17 | 内容增长信号 |
| 🤖 AI 调研 | 本周 12 次 · 3 进行中 | AI 能力使用情况 |
| 💰 本月成本 | $87 / 预算 $200 · 43% | 预算消耗监控 |

#### 3.2 4 个子 tab

| Tab | 功能 | v3.3 已有 |
|---|---|---|
| **审核队列** | 精华提名 + 分享审核双子 tab | 风险 5 整合 |
| 成员 | 列表 + 角色管理（设 admin / 禁用） | 现有 `users.role` |
| 统计 | 详细图表 | P1 |
| 设置 | 机器预审阈值 / 分享上限 / 调研上限 | 风险 5 整合 |

#### 3.3 审核队列设计（v3.3.1 详细化）

**子 tab 1：💎 精华提名**（机器预审 + 批量操作）
- 顶部开关：机器预审开/关、阈值 0.7
- 批量操作：全选 + 批量通过/拒绝
- 每条提名卡：
  - 来源标识：`⭐ x3 触发` / `✋ 主动提名`
  - 来源摘要（折叠）：原评论、所在文章
  - **admin 提炼草稿**（可编辑：标题 + 短文 + 标签）
  - AI 评分 0-1（机器预审）
  - 操作：通过入库 / 拒绝 / 查看上下文

**子 tab 2：🙋 分享审核**
- 与精华提名同款 UI
- 但展示 URL（可点）+ 用户备注 + AI 摘要
- 通过 = 写 summaries 表，summaries.source='user', status='pending_review' → 'published'

#### 3.4 成员管理（v3.3.1 新增）

表格列：成员 / 角色 / 本周贡献（长文+评论数）/ 最后活跃 / 操作（设 admin / 禁用）
- **设 admin 危险操作**需要二次确认（v3.3.1 必带 confirm dialog）
- **禁用账号** = 软删除（`users.disabled_at` 字段，v3.3.1 加）

```sql
ALTER TABLE users ADD COLUMN disabled_at timestamptz;  -- v3.3.1：禁用而非删除
```

#### 3.5 设置（v3.3.1 新增独立页）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| 机器预审开关 | 开 | 是否启用 LLM 给提名打 0-1 分 |
| 自动通过阈值 | 0.7 | AI 评分 ≥ 此值自动 approved（绕过 admin 手动审） |
| 分享需 admin 审核 | 开 | 关闭后用户分享直接 published（不推荐） |
| 每日分享上限 | 5 次/人 | v3.1 风险 5 |
| 每日 AI 调研上限 | 20 次/全团 | v3.1 风险 4 |

### 4. 🔥 热议（v3.3.1 新增顶栏 tab）

> 跨模块热度聚合：每日摘要 / 用户分享 / 调研 / 精华 4 类内容，按过去 7 天 ⭐ 增量 + 💬 评论数 + 浏览增量综合排名。

**3 个时间窗口**（同款下划线 tab）：本周 7 天 / 本月 30 天 / 全部时间

**展示规则**：
- 每条卡片左上角 `#1` `#2` ... 排名编号（灰色）
- 卡片信息：类型徽章（每日摘要/调研/精华/分享）+ 作者/来源 + 标题 + 摘要 + 标签 + 📈 本周 ⭐ 增量 + 💬 讨论数
- 排序算法：`score = (⭐_增量 × 3) + (💬_增量 × 2) + (浏览_增量 × 0.1)`，按 score desc 排

**为什么独立成 tab**（不放每日摘要里）：
- 每日摘要 = 时间维度（今天）
- 热议 = 热度维度（过去 7 天）= 跨模块
- 两个维度正交，**混合会让用户困惑"现在看的是早报还是活跃信号"**

---
