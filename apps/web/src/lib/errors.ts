// 错误码 → HTTP 状态映射表。
//
// 契约源：docs/contracts/error-codes.md §"HTTP 状态映射" 与 §"错误码清单"。
//
// ADR 0002 #5 复评：HTTP_STATUS 字面值仍保留在 @deep-research/shared（ai-engine
// 需要同一份字面常量做镜像），但 ERROR_CODE → HTTP_STATUS 的映射表放在 apps/web 这一层，
// 因为 ai-engine 不返回 HTTP 状态给客户端（错误码契约文档开头声明）。
//
// 关键 invariant：本表必须覆盖 packages/shared/src/errors.ts 里 ERROR_CODES 的全部 key。
// 任意 error code 缺失都会被 `errorStatus()` 兜底为 500，避免 BFF 把意外状态扔给前端。

import { NextResponse } from 'next/server';
import { ERROR_CODES, HTTP_STATUS } from '@deep-research/shared/errors';
import type { ApiError, ErrorCode } from '@deep-research/shared/errors';

/** ERROR_CODE → HTTP 状态码映射。 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  // Auth / 权限
  [ERROR_CODES.AUTH_NOT_AUTHENTICATED]: HTTP_STATUS.UNAUTHORIZED,
  [ERROR_CODES.AUTH_DOMAIN_NOT_ALLOWED]: HTTP_STATUS.FORBIDDEN,
  [ERROR_CODES.AUTH_ACCOUNT_DISABLED]: HTTP_STATUS.FORBIDDEN,
  [ERROR_CODES.PERMISSION_DENIED]: HTTP_STATUS.FORBIDDEN,

  // 草稿 / 发布
  [ERROR_CODES.DRAFT_NOT_FOUND]: HTTP_STATUS.NOT_FOUND,
  [ERROR_CODES.DRAFT_NOT_OWNER]: HTTP_STATUS.FORBIDDEN,
  [ERROR_CODES.DRAFT_ALREADY_PUBLISHED]: HTTP_STATUS.CONFLICT,

  // AI 调研
  [ERROR_CODES.AI_ENGINE_UNAVAILABLE]: HTTP_STATUS.SERVICE_UNAVAILABLE,
  [ERROR_CODES.AI_QUOTA_EXCEEDED]: HTTP_STATUS.TOO_MANY_REQUESTS,
  [ERROR_CODES.AI_INVALID_SOURCE_POLICY]: HTTP_STATUS.BAD_REQUEST,
  [ERROR_CODES.AI_SOURCE_NOT_VISIBLE]: HTTP_STATUS.FORBIDDEN,
  [ERROR_CODES.AI_IDEMPOTENCY_MISMATCH]: HTTP_STATUS.CONFLICT,
  [ERROR_CODES.AI_JOB_NOT_FOUND]: HTTP_STATUS.NOT_FOUND,
  [ERROR_CODES.AI_JOB_NOT_CANCELLABLE]: HTTP_STATUS.CONFLICT,

  // Week 6 AI 多轮追问
  [ERROR_CODES.AI_CHAT_SEED_NOT_FOUND]: HTTP_STATUS.NOT_FOUND,
  [ERROR_CODES.AI_CHAT_FORBIDDEN_SEED]: HTTP_STATUS.FORBIDDEN,
  [ERROR_CODES.AI_CHAT_SESSION_NOT_FOUND]: HTTP_STATUS.NOT_FOUND,
  [ERROR_CODES.AI_CHAT_CONTENT_TOO_LONG]: HTTP_STATUS.BAD_REQUEST,
  [ERROR_CODES.AI_CHAT_SESSION_CLOSED]: HTTP_STATUS.FORBIDDEN,

  // 文件导入 / URL 抓取
  [ERROR_CODES.IMPORT_FILE_TOO_LARGE]: 413,
  [ERROR_CODES.IMPORT_INVALID_MIME]: 415,
  [ERROR_CODES.IMPORT_NOT_UTF8]: HTTP_STATUS.UNPROCESSABLE,
  [ERROR_CODES.IMPORT_HTML_UNSAFE]: HTTP_STATUS.UNPROCESSABLE,
  [ERROR_CODES.IMPORT_HASH_DUPLICATE]: HTTP_STATUS.CONFLICT,
  [ERROR_CODES.URL_FETCH_BLOCKED]: HTTP_STATUS.BAD_REQUEST,
  [ERROR_CODES.URL_FETCH_TIMEOUT]: HTTP_STATUS.GATEWAY_TIMEOUT,
  [ERROR_CODES.URL_FETCH_TOO_LARGE]: 413,
  [ERROR_CODES.URL_REDIRECT_LIMIT]: HTTP_STATUS.BAD_GATEWAY,

  // 评论 / 提名
  [ERROR_CODES.COMMENT_TARGET_INVALID]: HTTP_STATUS.UNPROCESSABLE,
  [ERROR_CODES.COMMENT_SELF_STAR_FORBIDDEN]: HTTP_STATUS.UNPROCESSABLE,
  [ERROR_CODES.COMMENT_ALREADY_NOMINATED]: HTTP_STATUS.CONFLICT,

  // Admin
  [ERROR_CODES.ADMIN_QUEUE_EMPTY]: HTTP_STATUS.NOT_FOUND,
  [ERROR_CODES.ADMIN_NOT_ENOUGH_ADMINS]: HTTP_STATUS.UNPROCESSABLE,
  [ERROR_CODES.ADMIN_ACTION_REQUIRES_CONFIRM]: 412,

  // Worker
  [ERROR_CODES.WORKER_LEASE_LOST]: HTTP_STATUS.GONE,
  [ERROR_CODES.WORKER_TIMEOUT]: HTTP_STATUS.GATEWAY_TIMEOUT,
  [ERROR_CODES.WORKER_RETRY_EXHAUSTED]: HTTP_STATUS.SERVICE_UNAVAILABLE,

  // 通用
  [ERROR_CODES.VALIDATION_FAILED]: HTTP_STATUS.BAD_REQUEST,
  [ERROR_CODES.INTERNAL]: HTTP_STATUS.INTERNAL,
  [ERROR_CODES.NOT_IMPLEMENTED]: 501,
};

/** 取某个 error code 的 HTTP 状态；未知 code 兜底 500。 */
export function errorStatus(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code] ?? HTTP_STATUS.INTERNAL;
}

export interface ApiErrorOptions {
  code: ErrorCode;
  message: string;
  requestId: string;
  details?: unknown;
}

/** 构造 BFF 统一错误响应（NextResponse + ApiError body）。 */
export function toApiErrorResponse(opts: ApiErrorOptions): NextResponse<ApiError> {
  const status = errorStatus(opts.code);
  const body: ApiError = {
    code: opts.code,
    message: opts.message,
    requestId: opts.requestId,
    ...(opts.details !== undefined ? { details: opts.details } : {}),
  };
  return NextResponse.json(body, { status });
}

/** 仅构造 ApiError 对象（用于嵌套在 200 响应内的 error 字段；P0 不使用）。 */
export function buildApiError(opts: Omit<ApiErrorOptions, 'details'> & { details?: unknown }): ApiError {
  return {
    code: opts.code,
    message: opts.message,
    requestId: opts.requestId,
    ...(opts.details !== undefined ? { details: opts.details } : {}),
  };
}