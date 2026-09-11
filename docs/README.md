# 项目文档入口

> 更新日期：2026-09-11
> 这里是文档导航，不承载第二份项目状态。当前事实以 `PROJECT_STATUS.md` 为准。

## 先看哪一份

| 目的 | 文档 | 说明 |
|---|---|---|
| 了解当前进度、风险和验证证据 | [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) | 每次会话的第一站 |
| 测试用户功能 | [`FUNCTIONAL_CHECKLIST.md`](./FUNCTIONAL_CHECKLIST.md) | 短冒烟路径、功能矩阵、失败恢复和验收记录模板 |
| 理解当前系统 | [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 当前产品范围、架构、权限、安全和数据边界 |
| 跑 Web/Python E2E | [`E2E_TESTING.md`](./E2E_TESTING.md) | 环境、命令、测试设计和已知限制 |
| 修改 API、状态、错误或环境变量 | [`contracts/README.md`](./contracts/README.md) | 跨 runtime 的共享契约入口 |
| 做不可逆的架构或产品决策 | [`decisions/README.md`](./decisions/README.md) | ADR 索引 |
| 新人启动、开发和部署 | [`wiki/README.md`](./wiki/README.md) | getting started、development、deployment、operations |
| 查看当前未闭合的质量问题 | [`radar-zread-gaps.md`](./radar-zread-gaps.md) | Zread / enrichment 缺口快照 |
| 查看最近一轮体验审核 | [`ui-ux-review-20260908-round2.md`](./ui-ux-review-20260908-round2.md) | 当前 UI/UX follow-up |

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

## 维护规则

1. 当前行为只写 `README.md`、`ARCHITECTURE.md`、`contracts/`、`FUNCTIONAL_CHECKLIST.md` 或本项目 wiki 中对应的现役页面。
2. 当前状态、测试数字、follow-up 和真实验收证据只写 `PROJECT_STATUS.md`；周报只记录历史交付。
3. 已完成的计划不再放在根目录；需要追溯时移入 `archive/`，不删除原文。
4. 新增文档前先判断它属于当前规范、验收清单、契约/决策、运行手册还是历史证据；同一事实只保留一个权威解释。
5. 任何“已通过”“已修复”“已部署”都要带验证日期和证据，不以代码存在或旧周报替代真实验证。
