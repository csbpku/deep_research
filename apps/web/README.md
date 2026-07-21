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
│   │   ├── api/auth/[...nextauth]   # NextAuth handler（Google OAuth）
│   │   └── api/admin/ping            # Admin endpoint（验收 2 测试样本）
│   ├── lib/
│   │   ├── env.ts          # 启动期 Zod env 校验（§7）
│   │   ├── db.ts           # Prisma client singleton
│   │   ├── log.ts          # 结构化 JSON logger + 脱敏
│   │   ├── errors.ts       # ERROR_CODE → HTTP_STATUS 映射表
│   │   ├── api-handler.ts  # parseBody + 统一错误响应
│   │   └── auth/           # NextAuth config + session + permissions + allowlist
│   ├── components/         # 共享 UI 组件
│   └── types/next-auth.d.ts          # Session/JWT 类型扩展
├── tests/                  # 单元 + 集成测试（vitest）
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

## Week 1 落地范围

- **env 启动期校验** (`src/lib/env.ts`)：9 个字段 + strict 模式拒绝 ai-engine secret。
- **结构化日志** (`src/lib/log.ts`)：JSON 行 + `request_id` + 敏感字段名脱敏（password/token/cookie/api_key/secret/prompt/body/query/email 等）。
- **错误码 → HTTP 映射** (`src/lib/errors.ts`)：覆盖 `packages/shared/src/errors.ts` 的全部 39 个 key，缺失时兜底 500。
- **Auth** (`src/lib/auth/`)：NextAuth v5 + Google OAuth + JWT 策略（**不接 PrismaAdapter**，因 schema 没有 Account/Session/VerificationToken 三张表）。
  - signIn callback 校验 ALLOWED_EMAIL_DOMAINS + disabledAt
  - jwt callback 注入 uid/role/disabledAt
  - session callback 透传到 session.user
- **BFF helper**：
  - `requireUser(req)` → 401 if unauthenticated
  - `requireAdmin(req)` → 401/403 if not admin
  - `requireRole(user, 'admin')` / `requireOwner(user, resource)`
- **页面**：
  - `/` 首页（3 个 P0 入口卡片）
  - `/summaries` `/researches` `/ai-research` 占位页
  - `/admin` 服务端拦截：未登录 → /signin；非 admin → 403 提示
  - `/signin` 登录占位 + Google OAuth 提示

## 验收用例（Week 1 · IMPLEMENTATION_PLAN §三·验收 1-3）

| 用例 | 路径 | 期望 |
|---|---|---|
| 1a 正常登录 | 配置 GOOGLE_CLIENT_ID/SECRET + allowlist 用户登录 | 跳回首页，session 写入 |
| 1b 非 allowlist | 域外 Google 账号登录 | NextAuth `?error=AccessDenied` |
| 1c 已禁用账号 | DB `users.disabledAt` 非空用户登录 | signIn callback 返回 false |
| 2a Member 访问 Admin API | member 调用 `GET /api/admin/ping` | 403 PERMISSION_DENIED |
| 2b 直链 Admin 页面 | member 浏览器访问 `/admin` | 渲染 403 EmptyState |
| 2c 未登录访问 Admin | 浏览器访问 `/admin` | redirect `/signin?callbackUrl=/admin` |
| 3 schema 状态 | `prisma validate` / `db:generate` | 通过；本分支未产生新 migration |

## 自动化测试

```bash
pnpm --filter @deep-research/web typecheck    # tsc --noEmit
pnpm --filter @deep-research/web test         # vitest run
```

当前覆盖（54 个 case）：env 校验 / 脱敏日志 / 错误码映射 / allowlist / permissions / api-handler parseBody。

## Google OAuth 配置

1. 在 Google Cloud Console 创建 OAuth 2.0 Client（Web 应用类型）。
2. 「Authorized redirect URIs」登记：`http://localhost:3000/api/auth/callback/google`（与 NEXTAUTH_URL 一致）。
3. 把 Client ID / Secret 写入 `apps/web/.env`。
4. ALLOWED_EMAIL_DOMAINS 列出允许的邮箱域（CSV）。
5. 启动 `pnpm dev:web`，访问 `/signin`，用允许域的 Google 账号登录。

## 已知限制（Week 1 不实现）

- shadcn UI 全套组件未接入（Week 1 仅装 Tailwind；shadcn-ui 包是 CLI 而非组件库）
- NextAuth 的 React SessionProvider 未接入 `RootLayout`（Nav 的 admin 显隐占位由静态常量提供，Week 2 改造为 `useSession()`）
- 全套 admin 页面 UI / 审核队列 / 成员管理 = Week 8 任务
- 文件导入 / AI 调研 / 评论 / 分享 = Week 3+ 任务