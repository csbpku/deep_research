// 用户友好的错误展示 —— 把 BFF 返回的 ApiError 转成 zh-CN 短消息。
//
// 设计要点：
//   - 对网络/解析失败（无 ApiError.code）用稳定的 fallback 文案
//   - 走 ErrorCode 映射表（按 docs/contracts/error-codes.md）
//   - 默认不把后端的 message 直接展示（BFF 端可能含技术细节）
//   - `retryAfterSeconds` 用于提示「几秒后再试」

import { ERROR_CODES, type ErrorCode } from '@deep-research/shared/errors';

const GENERAL_FALLBACK = '网络异常，请稍后重试';

interface ApiErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
}

import { ApiHttpError, isRetryableStatus } from './api-error';

/**
 * 把任意 thrown error 转成「短」+「建议」两段。
 *
 * @param error 通常来自 fetch().then(...).catch(rethrow) 或 react-query queryFn
 * @param fallback 当无法识别时的兜底文案
 */
export function friendlyError(
  error: unknown,
  fallback: string = GENERAL_FALLBACK,
): { message: string; hint?: string } {
  // 1) ApiHttpError —— 自带 code/status/requestId
  if (error instanceof ApiHttpError) {
    const map = mapCode(error.code as ErrorCode);
    if (map.message === '请求失败' && isRetryableStatus(error.status)) {
      return { message: 'AI 调研服务暂时不可用', hint: '已自动重试一次，可能正在恢复中。' };
    }
    return map;
  }
  // 2) Plain Error but message happens to be JSON（兼容旧调用）
  if (error instanceof Error) {
    const api = parseMessageAsApiError(error.message);
    if (api?.code) return mapCode(api.code as ErrorCode);
    // 没 code 但是 Error：通常来自 fetch 网络失败/JSON 解析失败。
    if (/Failed to fetch|NetworkError|json/i.test(error.message)) {
      return { message: 'AI 调研服务暂时不可用', hint: '已自动重试一次，可能正在恢复中。' };
    }
    return { message: fallback };
  }
  // 3) 裸 ApiError 对象
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return mapCode(code as ErrorCode);
  }
  return { message: fallback };
}

/** 仅返回一句短消息（其余信息丢弃）。 */
export function friendlyMessage(error: unknown, fallback: string = GENERAL_FALLBACK): string {
  return friendlyError(error, fallback).message;
}

/**
 * React-Query retry 配置：网络/5xx 才重试，4xx 不重试。
 * 默认重试 1 次（200ms 后）。
 */
export function retryOnceAi(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  // 1) ApiHttpError 已知 code/status
  if (error instanceof ApiHttpError) {
    // AI_ENGINE_UNAVAILABLE 友好化，但仍然可重试
    if (error.code === ERROR_CODES.AI_ENGINE_UNAVAILABLE) return true;
    // 4xx 不重试
    if (error.status >= 400 && error.status < 500) return false;
    // 5xx 重试
    if (error.status >= 500) return true;
    return isRetryableStatus(error.status);
  }
  // 2) 未知 Error：可能是网络错误/JSON 解析失败 → 重试
  if (error instanceof Error) {
    const api = parseMessageAsApiError(error.message);
    if (!api) return true; // 无 code（典型网络错误）
    const c = api.code as ErrorCode;
    if (c === ERROR_CODES.AI_ENGINE_UNAVAILABLE) return true;
    return c !== ERROR_CODES.VALIDATION_FAILED;
  }
  // 3) 兜底重试
  return true;
}

// ─── helpers ─────────────────────────────────────────────────

function parseMessageAsApiError(message: string): ApiErrorBody | null {
  // BFF 的 fetch 错误处理长这样："{message: 'AI 调研服务暂时不可用，请稍后重试'}" —— 我们没把
  // code 拼进 message，所以从 message 反推 code 不可靠。
  // 这里只做"message 是 JSON 字符串"的兜底解析；常见情况是 React Query 已经 throw
  // `new Error('加载失败')` 包装，原 message 已失真。
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === 'object' && 'code' in parsed) {
      return parsed as ApiErrorBody;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function mapCode(code: ErrorCode): { message: string; hint?: string } {
  switch (code) {
    // AI
    case ERROR_CODES.AI_ENGINE_UNAVAILABLE:
      return { message: 'AI 调研服务暂时不可用', hint: '已自动重试一次，可能正在恢复中。' };
    case ERROR_CODES.AI_QUOTA_EXCEEDED:
      return { message: '今日 AI 调研配额已用完', hint: '明天再试，或联系 Admin 调整预算。' };
    case ERROR_CODES.AI_INVALID_SOURCE_POLICY:
      return { message: '指定资料的策略不合法' };
    case ERROR_CODES.AI_SOURCE_NOT_VISIBLE:
      return { message: '该资料对当前账户不可见' };
    case ERROR_CODES.AI_JOB_NOT_FOUND:
      return { message: '调研任务不存在或已被删除' };

    // Auth
    case ERROR_CODES.AUTH_NOT_AUTHENTICATED:
      return { message: '请先登录后再试' };
    case ERROR_CODES.AUTH_DOMAIN_NOT_ALLOWED:
      return { message: '当前邮箱不在允许名单内' };
    case ERROR_CODES.AUTH_ACCOUNT_DISABLED:
      return { message: '账号已停用' };
    case ERROR_CODES.PERMISSION_DENIED:
      return { message: '没有权限执行该操作' };

    // 评论
    case ERROR_CODES.COMMENT_TARGET_INVALID:
      return { message: '评论目标不存在' };
    case ERROR_CODES.COMMENT_SELF_STAR_FORBIDDEN:
      return { message: '不能给自己点赞提名' };
    case ERROR_CODES.COMMENT_ALREADY_NOMINATED:
      return { message: '该评论已经提名过' };

    // Admin
    case ERROR_CODES.ADMIN_QUEUE_EMPTY:
      return { message: '队列已处理完' };
    case ERROR_CODES.ADMIN_ACTION_REQUIRES_CONFIRM:
      return { message: '该操作需要二次确认' };

    // Worker
    case ERROR_CODES.WORKER_TIMEOUT:
      return { message: '任务执行超时' };
    case ERROR_CODES.WORKER_RETRY_EXHAUSTED:
      return { message: '任务多次重试仍失败', hint: '请检查后端 worker 状态。' };
    case ERROR_CODES.WORKER_LEASE_LOST:
      return { message: '任务 lease 已丢失', hint: '可能已被其他进程接管。' };

    // Import / Fetch
    case ERROR_CODES.IMPORT_FILE_TOO_LARGE:
      return { message: '文件过大' };
    case ERROR_CODES.IMPORT_INVALID_MIME:
      return { message: '文件类型不支持' };
    case ERROR_CODES.IMPORT_NOT_UTF8:
      return { message: '文件编码不是 UTF-8' };
    case ERROR_CODES.IMPORT_HTML_UNSAFE:
      return { message: '导入的内容含不安全的脚本/标签' };
    case ERROR_CODES.IMPORT_HASH_DUPLICATE:
      return { message: '已导入过相同内容' };
    case ERROR_CODES.URL_FETCH_BLOCKED:
      return { message: 'URL 在抓取黑名单中' };
    case ERROR_CODES.URL_FETCH_TIMEOUT:
      return { message: '抓取超时' };
    case ERROR_CODES.URL_FETCH_TOO_LARGE:
      return { message: '抓取内容过大' };
    case ERROR_CODES.URL_REDIRECT_LIMIT:
      return { message: '抓取重定向次数超限' };

    // 通用
    case ERROR_CODES.VALIDATION_FAILED:
      return { message: '参数不合法，请检查输入' };
    case ERROR_CODES.NOT_FOUND:
      return { message: '内容不存在或已删除' };
    case ERROR_CODES.INTERNAL:
      return { message: '服务器内部错误', hint: '请稍后重试或联系 Admin。' };
    case ERROR_CODES.NOT_IMPLEMENTED:
      return { message: '功能尚未实现' };
    default:
      return { message: '请求失败', hint: '请稍后重试。' };
  }
}
