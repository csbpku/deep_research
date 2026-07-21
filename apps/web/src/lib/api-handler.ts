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
import { toApiErrorResponse } from './errors.js';
import { log, withRequestId, serializeError } from './log.js';

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
 * 高阶 BFF handler 包装。
 *
 * 任何抛出的 Error 都会被捕获 → INTERNAL 500 + log。业务 handler 直接抛 Error 即可。
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