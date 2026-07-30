// BFF 通用 handler —— parseBody + 统一错误响应。
//
// 契约源：docs/contracts/api-schemas.md §"写入路径必须校验"。
// 扩展点：
//   - parseBody：zod 失败 → VALIDATION_FAILED + 400 + flattened issues
//   - apiHandler：高阶包装，统一 INTERNAL 500 + log
//   - requireUserHandler / requireAdminHandler：preset 包装

import { NextResponse } from 'next/server';
import type { ZodSchema } from 'zod';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { toApiErrorResponse } from './errors';
import { log, withRequestId, serializeError } from './log';

/** zod 解析 request body。失败返回 400 NextResponse，成功返回 data。 */
export async function parseBody<S extends ZodSchema>(
  req: Request,
  schema: S,
): Promise<Awaited<ReturnType<S['parse']>> | NextResponse> {
  const requestId = withRequestId(req.headers);
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    // body 不是 JSON
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'request body must be valid JSON',
      requestId,
      details: { reason: 'json_parse_failed' },
    });
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'request body invalid',
      requestId,
      details: result.error.flatten(),
    });
  }
  return result.data as Awaited<ReturnType<S['parse']>>;
}

/**
 * 跨域请求 Origin / Referer 校验。
 *
 * W9 安全复审修订（S0）：此前所有 BFF 变更路由无 CSRF 保护。
 * NextAuth 的 SameSite=Lax 覆盖了大部分基于 POST 的攻击，但不能替代
 * 显式的 Origin 校验 —— top-level navigation 中的 GET 和某些跨站 POST
 * 场景仍可能被利用。
 *
 * 在 apiHandler 内部调用：拒绝跨域变更请求（GET 以外），
 * 返回 403 + CSRF_ORIGIN_MISMATCH。
 */
function _checkOrigin(req: Request): NextResponse | undefined {
  if (req.method === 'GET') return; // GET 不做状态变更，不需要 CSRF

  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  if (!origin && !referer) return; // 无 Origin 无 Referer 可能是同源 fetch，放行

  const host = req.headers.get('host') ?? '';

  // 取 Origin / Referer 的 origin 部分比对 Host
  const candidate = origin ?? referer ?? '';
  try {
    const candidateHost = new URL(candidate).host;
    if (candidateHost === host) return; // 同源
  } catch {
    // 非标准格式，放行（只做 best-effort）
    return;
  }

  return toApiErrorResponse({
    code: ERROR_CODES.CSRF_ORIGIN_MISMATCH,
    message: '跨域请求被拒绝',
    requestId: 'unknown',
  });
}

/**
 * 高阶 BFF handler 包装。
 *
 * 任何抛出的 Error 都会被捕获 → INTERNAL 500 + log。业务 handler 直接抛 Error 即可。
 *
 * W9 安全复审修订：每个非 GET 请求在进入 handler 前先做 Origin/Referer
 * 同源校验（SameSite=Lax 的纵深防御）。本地开发（http://localhost:3000）
 * 无 Origin 头的 fetch 会被放行。
 *
 * 用法：
 *   export const POST = apiHandler(async (req) => {
 *     const body = await parseBody(req, MyInput);
 *     if (body instanceof NextResponse) return body;
 *     // ...
 *   });
 */
export function apiHandler<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<Response>,
): (...args: TArgs) => Promise<Response> {
  return async (...args: TArgs): Promise<Response> => {
    const req = args[0];
    const requestId =
      req && typeof req === 'object' && 'headers' in req && req.headers instanceof Headers
        ? withRequestId(req.headers)
        : 'unknown';
    try {
      // CSRF 防御（W9 安全复审修订）
      if (req && typeof req === 'object' && 'method' in req && 'headers' in req) {
        const csrfErr = _checkOrigin(req as Request);
        if (csrfErr) return csrfErr;
      }
      return await handler(...args);
    } catch (err) {
      // 已经是 NextResponse 的错误（业务 helper 返回的）直接透传
      if (err instanceof NextResponse) return err;
      log.error('api.handler', 'unhandled error', {
        requestId,
        err: serializeError(err),
      });
      return toApiErrorResponse({
        code: ERROR_CODES.INTERNAL,
        message: '服务器内部错误',
        requestId,
      });
    }
  };
}