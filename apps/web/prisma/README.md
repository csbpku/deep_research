# apps/web/prisma

> 数据库 schema 与迁移。**Week 0 锁定后工程师 A/B 不直接改**。
> 修改必须开 `[db]` PR，主会话 review；架构变更须同步更新
> `docs/ARCHITECTURE.md` §五 / `docs/IMPLEMENTATION_PLAN.md`。

当前 migration 顺序：

1. `20260716000000_base_schema`：创建首版 10 张表。
2. `20260717000000_init_constraints`：增加触发器、检查约束和 partial indexes；历史 migration 不修改。
3. `20260718000000_preflight_contract_completion`：增加指标/管理审计表、job 输出唯一外键与最终去重规则，共 12 张表。

主会话负责执行 migration。工程师 A/B 只能运行 `prisma validate` 和 `prisma generate`，不得并发创建或执行 migration。

主会话迁移后用 `psql postgresql://postgres:postgres@localhost:5432/deep_research -f apps/web/prisma/preflight-smoke.sql` 验证状态机约束和 Import 去重；脚本在事务内回滚，不留测试数据。
