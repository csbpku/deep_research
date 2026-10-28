# AI 调研规划语义 TDD 证据

来源：[优化方案](./ai-research-experience.plan.md)、[测试设计](./ai-research-experience.tdd.md)。

## 用户保证

- 比较对象只包含可靠命名对象；场景、范围与输出要求不进入候选。
- 模糊对象返回待确认，并使用用户可读的字段名称。
- 决策维度来自用户问题、背景或显式方案；通用比较不默认要求部署、磁盘和回滚。
- 显式运维问题继续保留带宽/性能、磁盘、部署和回滚的证据门禁；用户明确排除的维度不反向补入。
- 显式空维度不会变成默认矩阵，不以空矩阵冒充完成。

## RED / GREEN

- RED checkpoint：`98c2a2b`，仅增加测试。
- `pnpm --filter @deep-research/web test src/app/api/ai-research/__tests__/plan.test.ts src/lib/research-sufficiency.test.ts`：RED 为 8 失败、30 通过。真实 Playwright/Cypress 输入得到三个对象；asyncio 行为被当对象；明确空维度变为 16 格矩阵；显式参数被忽略。
- `pnpm --filter @deep-research/shared test src/schemas.test.ts`：RED 为 1 失败、13 通过，schema 默认包含不相关运维维度。
- GREEN checkpoint：`d416659`，新增纯语义 helper，修复 plan API、sufficiency 与共享默认值。
- 同一 Web 命令：38/38 通过；同一 shared 命令：14/14 通过。
- `pnpm --filter @deep-research/web typecheck`：通过。
- `pnpm --filter @deep-research/shared test`：5 文件、25/25 通过。

## 验证范围

| 保证 | 测试 | 类型 |
|---|---|---|
| 场景与要求不被拆成对象 | plan.test.ts 的真实 Playwright/Cypress 和 asyncio 输入 | API 单元 |
| 无空格中文、英文 and、原有三对象与 vs 格式兼容 | plan.test.ts | API 单元 |
| 模糊对象提示确认 | plan.test.ts | API 单元 |
| 指定/排除维度得到尊重 | plan.test.ts | API 单元 |
| 默认不强加运维维度 | shared schemas.test.ts、research-sufficiency.test.ts | 契约/单元 |
| 明确运维问题保留要求与量化证据门禁 | plan.test.ts、既有 research-sufficiency.test.ts | API/单元 |
| 显式空维度不被默认覆盖 | plan.test.ts、research-sufficiency.test.ts | API/单元 |

集成分支使用 Vitest v8 检查新增状态与规划纯逻辑，并执行真实浏览器和全量 Web 验收；最终范围和结果见体验优化 TDD 的验收记录。

比较对象使用保守规则，无法可靠识别的表达仍要求人工确认；不承诺任意自然语言命名实体识别。目标枚举保持原兼容值，展示文案为“主题概览 / 系统学习 / 机制分析 / 决策对比”。当前 Python 无 ResearchBrief/decisionDimensions 的 schema 镜像；写手模板对维度的使用由并行后端工作流处理。

## 独立审查后的第二轮 TDD

- RED checkpoint `f430e07`：新增引号名称（含 and、逗号、冒号）、“和鲸”首字、负向范围后的正向性能需求、排除项不能被默认恢复、不要忽略的语义及非决策目标的比较继承回归。实际运行 plan + submit-rejected：6 失败、29 通过，失败均命中新增保证。
- GREEN checkpoint `6f32918`：引号保护及逐项分隔保留名称；排除范围在转折分句结束，默认值过滤明确排除项；提交给引擎的“必须比较”只用于 decide。参数化提交测试每次提供独立 Response，避免同一响应体重复读取。
- `pnpm --filter @deep-research/web test src/app/api/ai-research/__tests__/plan.test.ts src/app/api/ai-research/__tests__/submit-rejected.test.ts src/lib/research-sufficiency.test.ts`：3 文件、49/49 通过。
- `pnpm --filter @deep-research/web typecheck`：通过。
- AiResearchBrief 的目标切换状态清理与所选历史资料可见性由父集成工作流处理，本分支未修改 UI。

## 最终真实 LLM 验收反馈：排除范围

隔离环境真实 LLM 验收后的只读查询确认：虽然用户写了“不展开无关的部署、磁盘或回滚”，持久化 brief 仍含这三项运维维度。根因是排除用语只覆盖“不讨论”等表达，遗漏“不展开”。

- RED `c67825b`：用真实完整提问及焦点做 plan API 回归，1 失败、29 通过；实际多出磁盘、部署和回滚三维。
- GREEN `bc931b0`：识别“不展开 / 不延伸 / 不扩展 / 不涵盖 / 不纳入”等排除表达。原回归连同 submission/sufficiency 共50/50通过。
- 未修改隔离数据库；历史任务保留原确认配置，新的验收需重新生成方案，不能把沿用旧5维配置的重跑当作新方案验证。
