# 共享契约入口

这里记录 Web、AI engine、共享类型和运维流程需要遵守的现役约定。系统行为以 [技术方案](../TECHNICAL_OVERVIEW.md) 和当前代码为准；Agent 规则、完整内部契约与日期化验收记录保留在本地维护层。

| 文件 | 内容 | 何时查阅 |
|---|---|---|
| [env-and-scripts.md](env-and-scripts.md) | 环境变量、脚本及服务命名 | 修改运行配置时 |
| [radar-governance.md](radar-governance.md) | 条件治理、补救预算、确认噪声删除与恢复 | 维护生产雷达与核验重试时 |
| [radar-quality-checklist.md](radar-quality-checklist.md) | 每条雷达必需内容、例外、公开门槛与逐条检查 | 检查完整性和质量证据时 |

修改契约时同时核对对应代码及消费者：共享 TypeScript/Python 类型位于 `packages/shared/` 和 AI engine 对应模块，数据库定义位于 `apps/web/prisma/schema.prisma`。按项目规则评审 schema/migration；接口或状态行为变化同步相关文档，并执行适用的跨运行时验证。架构决策保存在本地维护层，不引用历史实施计划作为现役流程。

快照、用户原文、备份和逐条生产清单只保留在私有证据目录；新增公开契约及脱敏报告须逐文件审阅后纳入 Git，不整体强制加入忽略目录。
