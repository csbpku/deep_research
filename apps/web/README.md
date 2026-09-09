# apps/web — Web 应用、BFF 与 Prisma

Next.js 15 App Router 应用，负责页面、认证授权、Web BFF、搜索/内容工作流和 Prisma 数据访问。跨运行时契约以根目录 `docs/contracts/`、`packages/shared/` 和 `apps/web/prisma/schema.prisma` 为准。

## 当前能力（2026-09-04）

- 页面：技术雷达与详情、主题、研究库/知识卡片、文件导入、AI 调研、搜索、登录和 Admin。
- AI 调研：研究稿、快速判断、Slides 提纲、独立网页简报；深度任务会展示实际证据进度，运行中/部分完成的研究稿可读但仍受事实审核和发布门禁约束。
- 雷达阅读：摘要先行、正文延迟加载、文章地图与选文动作；高价值 enrichment 的内容审核和真实浏览器渲染审核状态会单独展示，日报生成链路已移除。
- API：researches、knowledge、imports、radar、shares、search、AI research、chat session/message、auth 与 admin routes；包含任务取消、研究审核、知识卡片提炼和雷达文档刷新。
- 基础设施：NextAuth JWT + scrypt 邮箱密码登录、可选 Google OAuth、角色/owner 权限 helper、统一错误响应、结构化脱敏日志、TanStack Query、Prisma；开发环境默认使用 `.next-dev`，隔离构建可用 `NEXT_DIST_DIR`。

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

首次启动前，在仓库根目录执行 `./scripts/setup.sh --quick`（或准备好 `.env` 后执行 `pnpm db:deploy`），确保 PostgreSQL 已在 `localhost:5432` 运行。若使用 launchd 常驻 Web，则先执行 `pnpm --filter @deep-research/web build`，因为模板启动的是 `next start` 而不是开发服务器。

数据库 schema 和 migration 是共享契约；除非任务明确授权，不创建、修改或执行 migration。

## 验证

```bash
pnpm --filter @deep-research/web typecheck
pnpm --filter @deep-research/web test
pnpm --filter @deep-research/web build
```

不要在 README 固化测试数量；以当前命令输出和 CI 为准。

## 登录

1. 配置 `ALLOWED_EMAIL_DOMAINS` 和服务端 `AUTH_INVITE_CODE`，登录页只允许这些域名通过邀请码激活并登录，公开注册已关闭。
2. 密码使用 Node `crypto.scrypt` 哈希保存；最小长度为 12 个字符。
3. `BOOTSTRAP_ADMIN_EMAIL` 默认是 `shaobo.chen@shopee.com`；该初始管理员如果尚未设置密码，可在登录页用该邮箱和邀请码完成一次激活。
4. Google OAuth 是可选 provider；启用时，本地 redirect URI 使用 `http://localhost:3000/api/auth/callback/google`。
5. 公网使用邮箱密码登录前必须启用 HTTPS；HTTP 只适合本机或受控内网联调。

## 边界

- AI adapter、worker、抓取与长任务执行位于 `packages/ai-engine/`，不要放入 Next.js 请求进程。
- 错误码、状态和 schema 变更必须同步对应契约与跨语言镜像。
- 历史周交付记录只作为证据，不替代当前代码、测试与本 README。
