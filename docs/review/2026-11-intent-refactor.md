# 意图驱动的研究产物：第一轮重构

日期：2026-11-16
分支：`codex/product-funnel-fixes`（PR #56）

## 结论

现有 `RESEARCH_OBJECTIVE`（explore / learn / investigate / decide）不再只是计划文案，
而是会决定引擎的报告契约；确认页也会按意图选择默认产物。

第一轮只做“意图 → 契约 → 默认产物”，不重做检索链路，也不引入新的报告类型。

## 改了什么

1. **意图进入引擎请求**
   - `JobSnapshot` / `ResearchRequest` 增加 `objective`；
   - `db_store.py` 的 snapshot SQL 读取 `ai_research_jobs.objective`；
   - `runner.py` 把 objective 传进适配器。

2. **意图决定报告结构**
   - `gpt_researcher._intent_report_contract()`：
     - `learn`：一句话回答 / 心智模型 / 分层解释 / 可运行示例 / 边界与误区 / 自检 / 一手来源；
     - `investigate`：现象与范围 / 竞争假设 / 证据 / 判别性证据 / 结论与置信度 / 剩余不确定性；
     - `explore`：一句话概览 / 主题地图 / 关键问题 / 主要方向与分歧 / 证据缺口 / 下一步阅读；
     - `decide`：沿用已有对比/决策契约。
   - 已确认的意图优先于关键词比较启发式；用户在计划里选了 `learn`，不会因为上下文出现“取舍/对比”就被改写成选型报告。
   - 没有显式 objective 的旧调用保持原契约，避免影响历史测试和旧任务。

3. **默认产物由意图决定**
   - 确认页在用户未手动改过产物时：
     - `decide` → 决策备忘；
     - `learn` / `investigate` / `explore` → 完整报告。
   - 用户手动选择后不再被覆盖。

4. **详情页显示研究意图**
   - `/api/researches/[id]` 返回 `researchObjective`；
   - 详情页新增「系统学习 / 机制分析 / 主题概览 / 决策对比」徽章。

## 真实运行

引擎重启后，用真实 BFF + MiniMax 跑了两条任务。

### 学习型

- job `1d1aa12c-b152-4c2b-9dff-4bfdababdb51`
- 问题：PostgreSQL 的 MVCC 是如何工作的？
- 草稿 `10f474c5-9bd2-5412-a055-929190e20435`
- 结果：20,520 字，章节为
  `一句话回答 → 心智模型 → 分层解释 → 可运行示例 → 边界与常见误区 → 自检 → 一手来源与下一步`，
  包含 SQL 示例和三条常见误区；末尾仍有系统追加的参考文献（完整报告契约，不是备忘）。

### 机制分析

- job `0e0ebcbb-67e1-44ac-bf94-ea2df5895c57`
- 问题：PgBouncer transaction 模式下 Prisma prepared statement 为什么报 already exists？
- 草稿 `71a3e535-fa88-5915-bce4-1936d248969c`
- 结果：26,645 字，章节为
  `现象与范围 → 竞争假设 → 证据 → 判别性证据 → 结论与置信度 → 剩余不确定性`。

### 浏览器验证

- 详情页 `/researches/10f474c5-...` 渲染「系统学习」徽章。
- `/ai-research` 输入同一问题、发送后，产物单选中 `research_report`（而不是默认决策备忘）。

## 覆盖检查

学习与机制分析契约的末尾都要求一个 `## 覆盖检查` 表格：逐行列出计划中的必答问题，
标记“有证据 / 未知 / 冲突”。真实学习任务 `30c2d00e…` 的草稿
`47bbb255-0a9b-5899-9fb8-a933b8a7b801` 已生成该表，三行均为“有证据”，并带 [S#]。

局限与修正：首版把完成标准也并进了同一张表，标成“有证据”。现行契约要求
表格只放必答问题，完成标准另起一行标“已满足/未满足”；重跑草稿
`b5111bd9-7e41-5851-a157-d8028ccd668f` 已按此输出。

行内引用也改成紧凑 `[S#]`：学习/机制/概览三类产物不再把来源标题铺进正文，
完整链接只出现在文末参考来源。修复了一个幂等性 bug——writer 自带
`[S1](url)` 时不再被二次展开成 `[S1](url)(url)`。

## 发布门禁

`parseIntCoverage` 的输出现在同时用于发布：只要存在 `unknown` 或 `conflict`，
`POST /api/researches/[id]/publish` 在没有 `acknowledgeDisclosure` 时返回 400
`必答问题里仍有未知或冲突项；确认披露后才能继续发布`，并在 `details.intentCoverage`
里返回完整表格。编辑弹窗同步显示未知/冲突计数，勾选同一条披露后才允许发布。

实测：给 `b5111bd9…` 的覆盖表临时加入一条“未知”，不带确认调用发布返回 400；
`details.intentCoverage.counts` 与实际行一致。`partial` 仍只展示，不强制确认，
因为它是“有证据但有限定”，不是未覆盖。

## 仍未做

- 覆盖状态没有进入已发布版本的快照（已在后续提交补上）；
- 还没有独立的学习路径渲染器（目前是 Markdown 契约，不是交互式路径）；
- 对比意图仍复用 `decide`，没有“只对比不推荐”的开关；
- 学习产物仍偏长，尚未按投入档位限制篇幅。

## 覆盖快照

`Research.publishedIntentCoverage` 在发布时写入当时的解析结果（迁移
`20261116000003_published_intent_coverage`）。读者页优先用它，并标注
“发布时确认的覆盖状态”，而不是重新解析当前正文。

实测：发布 `b5111bd9…` 后快照计数为 `evidence 1 / partial 3`；随后在正文里临时
插入一条“未知”，详情 API 仍返回同一份快照（`intentCoverageSnapshot=true`），
读者不会看到发布后才出现的覆盖变化。测试后已还原正文。
