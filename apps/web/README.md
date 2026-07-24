# apps/web — Web 应用、BFF 与 Prisma

Next.js 15 App Router 应用，负责页面、认证授权、Web BFF、搜索/内容工作流和 Prisma 数据访问。跨运行时契约以根目录 `docs/contracts/`、`packages/shared/` 和 `apps/web/prisma/schema.prisma` 为准。

## 当前能力（2026-07-24）

- 页面：技术雷达与详情、每日摘要、沉淀列表/详情/编辑、文件导入、AI 调研、搜索、登录和精简 Admin。
- API：researches、imports、summaries、radar、shares、search、AI research、chat session/message、auth 与 admin routes。
- 基础设施：NextAuth Google OAuth、角色/owner 权限 helper、统一错误响应、结构化脱敏日志、TanStack Query、Prisma。
- Week 6 新增摘要上下文 AI 讨论抽屉及对应 BFF；具体历史验收见 `docs/weekly/week6-delivery.md`。

## 目录

```text
apps/web/
├── prisma/                 # schema、migrations、seed、preflight smoke
├── src/app/                # App Router 页面和 api/* BFF routes
├── src/components/         # 共享 UI 与交互组件
├── src/lib/                # auth、db、env、errors、logging、radar、search、chat BFF
└── src/types/              # NextAuth 类型扩展
```

## 本地开发

从仓库根目录执行：

```bash
pnpm install
pnpm --filter @deep-research/web exec prisma validate
pnpm db:generate
pnpm dev:web                 # http://localhost:3000
```

数据库 schema 和 migration 是共享契约；除非任务明确授权，不创建、修改或执行 migration。

## 验证

```bash
pnpm --filter @deep-research/web typecheck
pnpm --filter @deep-research/web test
pnpm --filter @deep-research/web build
```

不要在 README 固化测试数量；以当前命令输出和 CI 为准。

## Google OAuth

1. 创建 Google OAuth Web Client。
2. 本地 redirect URI 使用 `http://localhost:3000/api/auth/callback/google`。
3. 将配置写入 `apps/web/.env`，变量名以 `docs/contracts/env-and-scripts.md` 和 `.env.example` 为准。
4. 使用 `ALLOWED_EMAIL_DOMAINS` 限制允许登录的邮箱域。

## 边界

- AI adapter、worker、抓取与长任务执行位于 `packages/ai-engine/`，不要放入 Next.js 请求进程。
- 错误码、状态和 schema 变更必须同步对应契约与跨语言镜像。
- 历史周交付记录只作为证据，不替代当前代码、测试与本 README。
