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
}

export interface FetchAiEngineFailure {
  ok: false;
  code: ErrorCode;
  requestId: string;
  /** 直接给前端的用户可见 message（已翻译为 zh-CN）。 */
  message: string;
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
      const timer = setTimeout(() => ac.abort(), AI_ENGINE_TIMEOUT_MS);
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

  // 非期望状态 → 把上游 .code / .message 当成内部错误透出。
  const obj = parsed as { code?: string; message?: string; details?: unknown };
  const code = (obj.code as ErrorCode) ?? ERROR_CODES.AI_ENGINE_UNAVAILABLE;
  return {
    ok: false,
    code,
    requestId: opts.requestId,
    // 仍然翻译为友好 message，除非上游 .message 是已翻译的中文（P0 简单策略：直接信任上游 message）。
    message: obj.message ?? FRIENDLY_UPSTREAM_DOWN,
    // ⚠️ 详情塞在 details 字段，但本返回对象无该字段；调用方改用本函数再去取。
  };
}
