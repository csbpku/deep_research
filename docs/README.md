# 项目文档入口

> 面向使用者和开发者的现行文档入口。内部维护记录保存在本地忽略文件中，不作为 GitHub 文档发布。

## 先看哪一份

| 目的 | 文档 | 说明 |
|---|---|---|
| 快速理解当前技术方案 | [`TECHNICAL_OVERVIEW.md`](./TECHNICAL_OVERVIEW.md) | 系统职责、运行拓扑、核心数据流与集成边界 |
| 理解 Reader 产品边界与 Monica 对照 | [`READER_PRODUCT_DECISIONS.md`](./READER_PRODUCT_DECISIONS.md) | 原网页 UI 观察、技术阅读差异化、双模式权威数据边界和非目标 |
| 测试用户功能 | [`FUNCTIONAL_CHECKLIST.md`](./FUNCTIONAL_CHECKLIST.md) | 短冒烟路径、功能矩阵、失败恢复和验收记录模板 |
| 理解当前系统 | [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 当前产品范围、架构、权限、安全和数据边界 |
| 构建与验证 | 根目录 [`README.md`](../README.md) | 启动、类型检查、测试和构建命令 |
| 开发分支、跨电脑协作与 PR 发布 | [`CONTRIBUTING.md`](../CONTRIBUTING.md) | `main` 稳定基线、短期任务分支、CI、合并授权和部署状态 |
| 修改 API、状态、错误或环境变量 | [`contracts/README.md`](./contracts/README.md) | 跨 runtime 的共享契约入口 |
| 部署与回滚 | [`infra/README.md`](../infra/README.md) | 生产拓扑、镜像、健康检查和备份边界 |


## 维护规则

1. 当前行为只写 `README.md`、`TECHNICAL_OVERVIEW.md`、`ARCHITECTURE.md`、`contracts/`、`FUNCTIONAL_CHECKLIST.md` 或 wiki 中对应的现役页面。
2. 当前进度、测试数字、follow-up、真实验收证据、工作计划和复盘属于内部维护记录，保存在 Agent 规则、商店发布材料、`docs/PROJECT_STATUS.md`、`docs/weekly/` 等本地文件中；新增材料应被忽略，已跟踪文件需先从 Git 索引解除跟踪，才不会随提交发布到 GitHub。
3. 对外文档只描述稳定的系统行为、使用方法、契约和边界；不写阶段进度、一次性结果或内部部署状态。
4. 新增文档前先判断受众和类别；同一稳定事实只保留一个权威解释。
5. 外部发布状态必须以公开页面和正式版本为准；本地构建或草稿不写入对外文档。
6. `.gitignore` 中的内部目录若已被跟踪，需从 Git 索引解除跟踪并保留本地文件；忽略规则不会自动取消跟踪。
