// 客户端 ApiError —— 给 react-query 抛的错误挂上结构化字段。
//
// 使用：
//   const r = await fetch(...);
//   if (!r.ok) throw await toApiHttpError(r, '加载失败');
//
// 然后 friendly-error.ts 看 code 字段映射用户文案。

import { HTTP_STATUS, type ErrorCode } from '@deep-research/shared/errors';

export interface ApiErrorBody {
  code?: string;
  message?: string;
  requestId?: string;
  details?: unknown;
}

export class ApiHttpError extends Error {
  readonly code: ErrorCode | string;
  readonly requestId: string | undefined;
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(body: ApiErrorBody, status: number, fallback: string) {
    super(body.message ?? fallback);
    this.name = 'ApiHttpError';
    this.code = body.code ?? 'UNKNOWN';
    this.requestId = body.requestId;
    this.status = status;
    this.body = body;
  }
}

/** 把 fetch 失败的 Response 转成 ApiHttpError；无法解析 → fallback。 */
export async function toApiHttpError(res: Response, fallback: string): Promise<ApiHttpError> {
  let body: ApiErrorBody = {};
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    body = { message: `HTTP ${res.status}` };
  }
  if (typeof body.message !== 'string') body.message = undefined;
  return new ApiHttpError(body, res.status, fallback);
}

/** HTTP 5xx / 网络错误 → 是否可重试。 */
export function isRetryableStatus(status: number): boolean {
  return (
    status === 0 ||
    status === HTTP_STATUS.SERVICE_UNAVAILABLE ||
    status === HTTP_STATUS.GATEWAY_TIMEOUT ||
    status === HTTP_STATUS.BAD_GATEWAY ||
    status === HTTP_STATUS.TOO_MANY_REQUESTS
  );
}
