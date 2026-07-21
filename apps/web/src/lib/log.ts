// 结构化 logger。
//
// 全局 DoD 要求（IMPLEMENTATION_PLAN §一）：
//   - 关键操作写结构化日志，含 `request_id`
//   - 不记正文、prompt、access token、API key、secret
//   - 允许记 tokenInputTotal / tokenOutputTotal 数值
//
// 这里不引入 pino / winston 之类依赖 —— Week 1 只需要一行 JSON 输出 + 脱敏过滤。
// infra nginx log_format 脱敏（ADR 0002 #6）属于工程师 B 任务，本文件负责 web 进程内。

import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * 字段名脱敏黑名单（大小写不敏感）。任何匹配键都会被替换为 `'[REDACTED]'`。
 * 兜底覆盖 OAuth/AI 常见敏感字段，防止业务侧意外 log 出去。
 */
const REDACT_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'token',
  'access_token',
  'accesstoken',
  'authorization',
  'auth',
  'cookie',
  'set-cookie',
  'setcookie',
  'api_key',
  'apikey',
  'secret',
  'session',
  'jwt',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'idtoken',
  // prompt / 正文相关：AI engine / 用户输入原样禁止
  'prompt',
  'systemprompt',
  'body',
  'inputbody',
  'rawbody',
  'outputbody',
  'responsebody',
  'rawquery',
  'urlquery',
  'query',
  'searchparams',
  // 用户私密
  'email', // 业务需要 email 时单独传 email_domain 即可；邮箱本身不进日志
  'phone',
  'address',
]);

/** 递归脱敏；遇到 REDACT_KEYS 命中或值包含 HTML/JSON-like 长 body 时丢弃 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (value == null) return value;
  if (typeof value === 'string') {
    // 截断长字符串，避免 body / prompt 整段被 log 出去
    if (value.length > 2000) return value.slice(0, 2000) + '...[TRUNCATED]';
    return value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  if (raw in LEVEL_RANK) return raw;
  return 'info';
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[currentLevel()];
}

function emit(level: LogLevel, scope: string, msg: string, fields?: Record<string, unknown>): void {
  if (!shouldEmit(level)) return;
  const base = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(fields ?? {}),
  };
  const payload = redact(base);
  // 错误日志追加 err 字段；调用方若传 { err }，redact 后会保留 message / name / stack
  try {
    process.stdout.write(JSON.stringify(payload) + '\n');
  } catch {
    // 序列化失败时退化为单行字符串，避免污染 stdout
    process.stdout.write(JSON.stringify({ ts: base.ts, level, scope, msg, _log_error: 'serialize_failed' }) + '\n');
  }
}

export const log = {
  debug(scope: string, msg: string, fields?: Record<string, unknown>) {
    emit('debug', scope, msg, fields);
  },
  info(scope: string, msg: string, fields?: Record<string, unknown>) {
    emit('info', scope, msg, fields);
  },
  warn(scope: string, msg: string, fields?: Record<string, unknown>) {
    emit('warn', scope, msg, fields);
  },
  error(scope: string, msg: string, fields?: Record<string, unknown>) {
    emit('error', scope, msg, fields);
  },
};

/**
 * 生成或读取 request_id。优先用 incoming header；缺失则生成新 UUID。
 * 业务侧调用：`log.info(scope, msg, { requestId: withRequestId(req) })`。
 */
export function withRequestId(headers: Headers): string {
  const existing = headers.get('x-request-id');
  if (existing && /^[A-Za-z0-9._-]{8,128}$/.test(existing)) return existing;
  return randomUUID();
}

/**
 * error 对象序列化。stack 在 prod 截断前 800 字符。
 */
export function serializeError(err: unknown, opts: { truncateStack?: boolean } = {}): Record<string, unknown> {
  if (err == null) return { message: 'unknown' };
  if (err instanceof Error) {
    const out: Record<string, unknown> = { name: err.name, message: err.message };
    if (err.stack) {
      const truncated = opts.truncateStack === false ? err.stack : err.stack.slice(0, 800);
      out.stack = truncated;
    }
    return out;
  }
  return { value: String(err) };
}