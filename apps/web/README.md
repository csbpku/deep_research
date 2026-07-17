# apps/web — Web 应用 + BFF + Prisma

> 工程师 A：Web / 产品流 独占领域。其他角色可读，不可写。
> 详见根 README "工程师 A 工作边界" 段。

## 模块边界

```
apps/web/
├── prisma/
│   └── schema.prisma       # 由主会话变更；A/B 不得直接改
├── src/
│   ├── app/                # Next.js 15 App Router 页面
│   ├── lib/
│   │   ├── auth/           # NextAuth + 权限 helper
│   │   ├── api/            # BFF API routes（按 ARCHITECTURE §四 模块划分）
│   │   ├── db/             # Prisma client + 查询包装
│   │   └── errors/         # 错误码契约（与 docs/contracts/error-codes.md 对齐）
│   ├── components/         # 共享 UI 组件
├── tests/                  # 单元 + 集成测试
└── data/import-tmp/        # P0 文件导入临时目录（24h 清理，gitignore）
```

## 本地开发

```bash
pnpm install                # 在仓库根
pnpm --filter @deep-research/web exec prisma validate
pnpm --filter @deep-research/web db:generate
pnpm --filter @deep-research/web dev    # http://localhost:3000
```

Migration 只由主会话执行。工程师 A/B 不创建或运行 migration。

AI/import worker 位于 `packages/ai-engine/`，不与 Next.js HTTP 进程混跑。
