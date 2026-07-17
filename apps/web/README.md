# apps/web — Web 应用 + BFF + Prisma + 后台 AI worker

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
│   └── worker/             # 后台 AI worker + lease recover（架构 §十三）
├── tests/                  # 单元 + 集成测试
└── data/import-tmp/        # P0 文件导入临时目录（24h 清理，gitignore）
```

## 本地开发

```bash
pnpm install                # 在仓库根
pnpm --filter @deep-research/web db:migrate
pnpm --filter @deep-research/web dev    # http://localhost:3000
```

后台 worker 跑在同一进程（`tsx src/worker/index.ts`），也可以独立进程跑（`pnpm worker:run`）。
