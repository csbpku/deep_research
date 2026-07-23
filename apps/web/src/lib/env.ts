// 启动期 env 校验。规则见 docs/contracts/env-and-scripts.md §2 + §7。
//
// 命名规则（§4）：全大写下划线；时间量带完整单位后缀。
// 这里只解析 apps/web 自己关心的变量；ai-engine 的 secret（Tavily / Anthropic /
// OpenAI）禁止出现在 web 进程（env-and-scripts.md §2 "禁止"）。
//
// 校验失败必须立即抛出，不允许静默退化 —— 缺关键变量意味着 OAuth 不可能工作。

import { z } from 'zod';

const csvDomains = z
  .string()
  .min(1, 'ALLOWED_EMAIL_DOMAINS must not be empty')
  .transform((s) =>
    s
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  )
  .refine((arr) => arr.length > 0, 'ALLOWED_EMAIL_DOMAINS must contain at least one domain');

const positiveInt = z
  .string()
  .transform((s) => Number(s))
  .pipe(z.number().int().positive());

const positiveNumber = z
  .string()
  .transform((s) => Number(s))
  .pipe(z.number().positive());

/** apps/web env schema —— 与 docs/contracts/env-and-scripts.md §2 对齐 */
const webEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      // 形状校验；不强制解析具体驱动，避免 web 进程耦合 PG 版本。
      .refine((s) => /^postgres(ql)?:\/\//.test(s), 'DATABASE_URL must be a postgres:// URL'),

    NEXTAUTH_URL: z.string().url('NEXTAUTH_URL must be a URL').default('http://localhost:3000'),
    NEXTAUTH_SECRET: z
      .string()
      .min(8, 'NEXTAUTH_SECRET must be at least 8 chars; rotate in real deployments'),

    AI_ENGINE_URL: z.string().url('AI_ENGINE_URL must be a URL').default('http://localhost:4000'),

    GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required for Google OAuth'),
    GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required for Google OAuth'),
    ALLOWED_EMAIL_DOMAINS: csvDomains,

    MAX_UPLOAD_SIZE_MB: positiveInt.default('5'),
    TIME_VALUE_USD_PER_HOUR: positiveNumber.default('50'),
  })
  .passthrough(); // Next.js 注入大量内部 env keys；只校验已知变量，放过未知 key

export type WebEnv = z.infer<typeof webEnvSchema>;

/**
 * 解析并校验 process.env；启动期失败立即抛错。
 *
 * 调用方：apps/web/src/lib/auth/config.ts、任何读取 env 的代码。
 * 注意：Next.js dev 模式下 .env 变化会触发模块重载；调用一次即可。
 */
export function parseWebEnv(source: NodeJS.ProcessEnv = process.env): WebEnv {
  const result = webEnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    // 直接抛错并退出。Next.js dev 会显示堆栈，方便开发者定位 .env 缺什么。
    throw new Error(`Invalid apps/web environment:\n${issues}`);
  }
  return result.data;
}

// 启动期解析一次。如果失败进程会在这里崩；这是设计目标（env-and-scripts.md §7）。
// 注意：vitest 在测试环境会替换 process.env；测试里请使用 parseWebEnv(env) 显式传入。
let _cached: WebEnv | null = null;

/**
 * 解析后的 env 单例。生产路径上等于 `parseWebEnv()`，但允许测试在 setup 阶段
 * 注入一个 process.env stub（vitest 内部不会污染模块顶层副作用）。
 */
export function getWebEnv(): WebEnv {
  if (!_cached) _cached = parseWebEnv();
  return _cached;
}

// 模块顶层立即解析（仅在非测试环境）。在 vitest 里通常 NODE_ENV=test 且缺关键 env，
// 因此加 NODE_ENV 判断跳过顶层解析；测试与运行时代码统一走 getWebEnv() / parseWebEnv()。
if ((process.env.NODE_ENV ?? 'development') !== 'test') {
  _cached = parseWebEnv();
}

/** 提取邮箱域名（@ 后的小写串）。空 email / 空本地部分返回 ''。 */
export function emailDomain(email: string): string {
  if (typeof email !== 'string' || email.length === 0) return '';
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return '';
  return email.slice(at + 1).toLowerCase();
}