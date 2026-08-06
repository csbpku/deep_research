// 反代 ai-engine 的统一客户端 —— 周五最后再 P1：
//   - fetch 一次失败 → 自动重试 1 次（间隔 200ms）
//   - 错误友好化：HTTP 5xx / 网络错误 → `AI_ENGINE_UNAVAILABLE` + 友好中文 message
//   - JSON 解析失败 → 同上（不再把「返回非 JSON」抛出）
//
// ⚠️ 不要在这里 throw 中文 message —— message 留给前端 friendly-error.ts 做映射。
// 本端返回的 message 已经是稳定的英文契约 key，前端再翻译。
//
// 当前依赖：仅用于 ai-research 的 [jobId] / jobs 两个 BFF。

import { ERROR_CODES, type ErrorCode } from '@deep-research/shared/errors';
import { log, serializeError } from '../log';


const AI_ENGINE_TIMEOUT_MS = 5_000;
const AI_ENGINE_RETRY_DELAY_MS = 250;

export interface FetchAiEngineOptions {
  url: string;
  requestId: string;
  /** 期望返回的 HTTP 状态，默认 200。可用 204 表示「接受」 */
  expect?: number;
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** 每次 retry 前打日志；用于回溯「为什么重试了」 */
  context: string; // 例如 "ai.bff.status" / "ai.bff.list"
  /** Long-running reviewer calls can exceed the normal 5s polling budget. */
  timeoutMs?: number;
}

export interface FetchAiEngineFailure {
  ok: false;
  code: ErrorCode;
  requestId: string;
  /** 直接给前端的用户可见 message（已翻译为 zh-CN）。 */
  message: string;
  details?: unknown;
}

export interface FetchAiEngineSuccess<T> {
  ok: true;
  body: T;
  /** 上游状态码，用于诊断。 */
  status: number;
}

export type FetchAiEngineResult<T> = FetchAiEngineSuccess<T> | FetchAiEngineFailure;

const FRIENDLY_UPSTREAM_DOWN = 'AI 调研服务暂时不可用，请稍后重试';

/**
 * 反代 ai-engine 的 GET（其他方法走 POST/DELETE 参数）。
 *
 * 错误语义：
 *   - 网络/超时/JSON 解析失败 → ok:false, code=AI_ENGINE_UNAVAILABLE
 *   - 上游 5xx → ok:false, code=AI_ENGINE_UNAVAILABLE
 *   - 上游 4xx → ok:false, code=上游 .body.code（如有）否则 AI_ENGINE_UNAVAILABLE
 *
 * ⚠️ 本函数**不**throw，所有错误都收敛为 ok:false 的结果对象；
 * 上层把对象转成 NextResponse。
 */
export async function fetchAiEngine<T = unknown>(
  opts: FetchAiEngineOptions,
): Promise<FetchAiEngineResult<T>> {
  const method = opts.method ?? 'GET';
  const expect = opts.expect ?? 200;

  let upstreamRes: Response | null = null;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? AI_ENGINE_TIMEOUT_MS);
      upstreamRes = await fetch(opts.url, {
        method,
        headers: {
          'x-request-id': opts.requestId,
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ac.signal,
      });
      clearTimeout(timer);
      // 不重试 4xx；只重试网络错误 / 5xx
      if (upstreamRes.ok || (upstreamRes.status >= 400 && upstreamRes.status < 500)) {
        break;
      }
      // 5xx：重试 1 次
      lastErr = new Error(`upstream_status_${upstreamRes.status}`);
      log.warn(opts.context, 'upstream 5xx, retrying', {
        requestId: opts.requestId,
        attempt,
        status: upstreamRes.status,
        url: opts.url,
      });
      upstreamRes = null;
    } catch (err) {
      lastErr = err;
      log.warn(opts.context, 'upstream fetch failed, retrying', {
        requestId: opts.requestId,
        attempt,
        err: serializeError(err),
        url: opts.url,
      });
    }
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, AI_ENGINE_RETRY_DELAY_MS));
    }
  }

  if (upstreamRes === null) {
    log.error(opts.context, 'upstream unreachable after retry', {
      requestId: opts.requestId,
      err: serializeError(lastErr),
      url: opts.url,
    });
    return {
      ok: false,
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      requestId: opts.requestId,
      message: FRIENDLY_UPSTREAM_DOWN,
    };
  }

  const text = await upstreamRes.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    log.warn(opts.context, 'upstream returned non-JSON', {
      requestId: opts.requestId,
      status: upstreamRes.status,
      preview: text.slice(0, 80),
      url: opts.url,
    });
    return {
      ok: false,
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      requestId: opts.requestId,
      message: FRIENDLY_UPSTREAM_DOWN,
    };
  }

  if (upstreamRes.status === expect) {
    return { ok: true, body: parsed as T, status: upstreamRes.status };
  }

  // 非期望状态：FastAPI/Pydantic 的 400/422 通常只有 detail，没有业务
  // code。它们是输入问题，不应被伪装成 AI engine 宕机。
  const obj = parsed as { code?: string; message?: string; details?: unknown; detail?: unknown };
  const isInputError = upstreamRes.status === 400 || upstreamRes.status === 422;
  const code = (obj.code as ErrorCode) ?? (isInputError ? ERROR_CODES.VALIDATION_FAILED : ERROR_CODES.AI_ENGINE_UNAVAILABLE);
  const details = obj.details ?? (isInputError ? sanitizeUpstreamDetail(obj.detail) : undefined);
  return {
    ok: false,
    code,
    requestId: opts.requestId,
    message: obj.message ?? (isInputError ? 'AI 请求参数不合法，请重新选择文本后重试' : FRIENDLY_UPSTREAM_DOWN),
    ...(details === undefined ? {} : { details }),
  };
}

/** Keep FastAPI validation details useful without exposing request contents. */
function sanitizeUpstreamDetail(detail: unknown): unknown {
  if (!Array.isArray(detail)) return undefined;
  return detail.slice(0, 10).map((item) => {
    if (!item || typeof item !== 'object') return { message: '参数不合法' };
    const record = item as Record<string, unknown>;
    const location = Array.isArray(record.loc)
      ? record.loc.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number').slice(0, 5)
      : undefined;
    return {
      ...(location ? { location } : {}),
      message: typeof record.msg === 'string' ? record.msg.slice(0, 160) : '参数不合法',
      type: typeof record.type === 'string' ? record.type.slice(0, 80) : undefined,
    };
  });
}
