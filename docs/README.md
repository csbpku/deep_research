# 项目文档入口

> 更新日期：2026-09-14
> 当前技术方案只保留一份摘要；日期化运行证据与历史材料分开存放。

## 先看哪一份

| 目的 | 文档 | 说明 |
|---|---|---|
| 快速理解当前技术方案 | [`TECHNICAL_OVERVIEW.md`](./TECHNICAL_OVERVIEW.md) | 当前实现、运行拓扑、服务生命周期和文档分层 |
| 查看日期化进度、部署和验证证据 | [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) | 只记录事实，不承载架构说明 |
| 测试用户功能 | [`FUNCTIONAL_CHECKLIST.md`](./FUNCTIONAL_CHECKLIST.md) | 短冒烟路径、功能矩阵、失败恢复和验收记录模板 |
| 理解当前系统 | [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 当前产品范围、架构、权限、安全和数据边界 |
| 跑 Web/Python E2E | [`E2E_TESTING.md`](./E2E_TESTING.md) | 环境、命令、测试设计和已知限制 |
| 修改 API、状态、错误或环境变量 | [`contracts/README.md`](./contracts/README.md) | 跨 runtime 的共享契约入口 |
| 做不可逆的架构或产品决策 | [`decisions/README.md`](./decisions/README.md) | ADR 索引 |
| 新人启动、开发和部署 | [`wiki/README.md`](./wiki/README.md) | getting started、development、deployment、operations |
| 查看历史质量快照 | [`archive/2026-09-14-knowledge-closeout/radar-zread-gaps-20260908.md`](./archive/2026-09-14-knowledge-closeout/radar-zread-gaps-20260908.md) | 2026-09-08 的 Zread / enrichment 快照，不是当前基线 |
| 查看历史体验审核 | [`archive/2026-09-14-knowledge-closeout/ui-ux-review-20260908-round2.md`](./archive/2026-09-14-knowledge-closeout/ui-ux-review-20260908-round2.md) | 2026-09-08 的 UI/UX 复盘，不是当前规范 |

## 历史材料

- [`weekly/`](./weekly/)：按周保存交付证据。它是历史记录，不是当前行为的唯一依据。
- [`archive/`](./archive/)：已完成计划、旧版方案、一次性 prompt、旧 mockup 和被替代的评审记录。
- [`inputs/`](./inputs/)：外部参考材料，只读；其中的时点数据使用前要重新核验。

当前已归档：

- [`archive/2026-09-08-implementation-plan.md`](./archive/2026-09-08-implementation-plan.md)：W1-W13 实施计划
- [`archive/2026-09-08-p1-plan.md`](./archive/2026-09-08-p1-plan.md)：P1 执行计划
- [`archive/2026-09-08-diagrams-v3.6.md`](./archive/2026-09-08-diagrams-v3.6.md)：旧版产品全景图
- [`archive/2026-09-08-agent-prompts/`](./archive/2026-09-08-agent-prompts/)：W1-W5 Agent prompt
- [`archive/2026-09-08-mockups/`](./archive/2026-09-08-mockups/)：旧版视觉 mockup
- [`archive/2026-09-08-ui-ux-review-round1.md`](./archive/2026-09-08-ui-ux-review-round1.md)：被 Round 2 替代的 UI/UX review
- [`archive/2026-09-14-knowledge-closeout/`](./archive/2026-09-14-knowledge-closeout/)：本次收口归档的项目状态、Zread 快照、UI/UX 复盘和一次性日报

## 维护规则

1. 当前行为只写 `README.md`、`TECHNICAL_OVERVIEW.md`、`ARCHITECTURE.md`、`contracts/`、`FUNCTIONAL_CHECKLIST.md` 或 wiki 中对应的现役页面。
2. 当前状态、测试数字、follow-up 和真实验收证据只写 `PROJECT_STATUS.md`；周报和复盘只记录历史交付。
3. 已完成的计划不再放在根目录；需要追溯时移入 `archive/`，不删除原文。
4. 新增文档前先判断它属于当前规范、验收清单、契约/决策、运行手册还是历史证据；同一事实只保留一个权威解释。
5. 任何“已通过”“已修复”“已部署”都要带验证日期和证据，不以代码存在或旧周报替代真实验证。
6. 不把 `PROJECT_STATUS.md`、weekly、一次性评审或中间计划当作技术方案摘要；它们只回答“何时发生过什么”。

补充：`contracts/`、`wiki/`、`weekly/`、`archive/` 和 `PROJECT_STATUS.md` 按仓库
`.gitignore` 约定属于本地知识层，不会自动进入 Git 提交。需要让某份契约或运维页
成为公开仓库的一部分时，应先明确取消忽略并单独 review；当前技术方案摘要已放在
未忽略的 `TECHNICAL_OVERVIEW.md`。
