# 开发、分支与发布流程

本流程适用于项目维护者和获授权的 Bot。GitHub `main` 是唯一稳定代码基线；本地目录、历史任务分支和生产机上的临时快照不能代替它。

## 开始任务

先读取项目根目录的 `AGENTS.md`。检查工作区并刷新远端引用，再从 `origin/main` 创建本任务的短期分支：

```bash
git status --short
git fetch origin
git switch -c codex/radar-filter-fix origin/main
```

分支名使用 `codex/` 前缀和简短功能名，一项任务对应一个分支。不要直接在 `main` 开发，也不要复用 `codex/radar-pdf-evidence` 等历史任务分支。工作区已有其他改动时，保留它们并改用独立 checkout；不要自动覆盖、强制 reset 或混入本次提交。

不同电脑使用各自的 clone，统一通过 GitHub 推送与 PR 协作。本地分支数量可以不同，开始任务时都以刷新后的 `origin/main` 为准。同一台电脑上多个 Agent 并行时使用各自的 worktree，不切换其他 Agent 正在使用的工作目录或分支。

## 提交与 PR

1. 只提交本任务的源码、测试和现役文档。凭据、内部维护记录与验收产物不进入提交；`.gitignore` 不会自动取消已跟踪文件。
2. 运行与改动对应的验证；主要入口是 `pnpm typecheck`、`pnpm test`，Python 改动另跑 pytest、Ruff 和 mypy。UI 行为变化补充相关浏览器验收，构建变化验证生产构建。
3. 推送任务分支并创建目标为 `main` 的 PR：

```bash
git push -u origin codex/radar-filter-fix
gh pr create --base main --head codex/radar-filter-fix
```

4. PR 说明具体变化、验证结果和部署影响；报告分支名、提交 SHA、PR 链接和 CI 状态。无权限或 CI 失败时明确报告，不能把本地提交称为已推送或已发布。
5. 合并前确保 PR 基于最新 `main`、无未解决冲突，且三项 CI 均成功：Web 类型/单测/构建、Web Playwright E2E、Python 质量与 E2E。禁止绕过失败检查或强推覆盖他人提交。

## 合并与部署

`main` 的 push CI 成功后会自动触发 Deploy，构建 Web 和 AI engine 的 commit-SHA 镜像并部署 VPS。因此，合并 `main` 同时具有发布影响，需要用户明确授权合并/发布。用户已授权本次合并与发布后，继续执行到生产验证完成，不重复请求确认。

正常路径为：任务分支 → PR → CI 通过 → 获授权合并 `main` → main CI → Actions Deploy → 生产验证。推送功能分支、PR 创建、CI 通过、PR 已合并、已部署、真实用户路径通过是不同状态，应分别报告。

生产检查至少确认部署镜像/marker 对应目标 SHA、Web 和 AI 服务健康、公开健康检查与内部接口隔离，以及本次改动对应的真实用户路径。部署与回滚操作见 [`infra/README.md`](./infra/README.md)。Chrome 扩展商店发布是单独流程，后端发布不代表商店版本已更新。

直接 VPS 或工作区快照部署只用于用户明确授权的例外；保留源码指纹、实际镜像、配置与回滚凭证，并在后续 PR 回收至 `main`。不要把例外发布当作常规开发捷径。

## 合并后与交接

各电脑完成任务后重新获取远端并快进本地 `main`：

```bash
git fetch origin
git switch main
git merge --ff-only origin/main
```

如果无法快进，先检查本地独有提交，不要强制覆盖。下一项任务再从更新后的 `origin/main` 创建新分支。旧任务分支、worktree、构建和验收证据在结果汇报后获得清理确认才删除。

给另一台电脑的 Bot 派活时，可直接附上：

> 读取 AGENTS.md 与 CONTRIBUTING.md；fetch 后从最新 origin/main 新建 codex/本任务分支，只提交本任务改动；推送并创建目标为 main 的 PR，完成验证并报告提交 SHA、PR 链接和 CI 结果。等待本次合并/发布授权，再合回 main 并跟进 Actions 与生产验证。
