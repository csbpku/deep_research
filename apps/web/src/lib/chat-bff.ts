// Shared chat BFF helpers: upstream fetch, error normalization, ownership checks, and
// response shaping. Keeping these details here makes all three routes use the same
// timeout/request-id/error behavior.

import { NextResponse } from 'next/server';
import { ERROR_CODES } from '@deep-research/shared/errors';
import type { ErrorCode } from '@deep-research/shared/errors';
import { getWebEnv } from './env';
import { toApiErrorResponse } from './errors';
import { log, serializeError } from './log';

export const CHAT_READ_TIMEOUT_MS = 5_000;
export const CHAT_WRITE_TIMEOUT_MS = 10_000;

export interface ChatSeedSnapshot {
  id: string;
  title: string;
  url: string;
  body: string;
  interpretation: string | null;
  summary_date: string;
  tags: string[];
  // Phase 1 deep-dive: original source captured by radar sync. Null
  // for pre-Phase-0 rows; chat UI should hide the "AI 上下文：原文"
  // chip when both are null.
  original_markdown: string | null;
  original_kind: string | null;
}

export interface UpstreamChatMessage {
  id?: string;
  message_id?: string;
  role: 'user' | 'assistant';
  content: string;
  sources_json: Array<{ title: string; url: string; snippet: string }> | null;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_cents: number | null;
  created_at: string;
}

export interface UpstreamChatSession {
  session_id: string;
  user_id?: string;
  userId?: string;
  status: 'active' | 'closed';
  created_at: string;
  updated_at?: string;
  seed_snapshot: ChatSeedSnapshot;
  message_count?: number;
  messages?: UpstreamChatMessage[];
}

const CHAT_ERROR_CODES = new Set<string>([
  ERROR_CODES.AI_ENGINE_UNAVAILABLE,
  ERROR_CODES.AI_QUOTA_EXCEEDED,
  ERROR_CODES.AI_CHAT_SEED_NOT_FOUND,
  ERROR_CODES.AI_CHAT_FORBIDDEN_SEED,
  ERROR_CODES.AI_CHAT_SESSION_NOT_FOUND,
  ERROR_CODES.AI_CHAT_CONTENT_TOO_LONG,
  ERROR_CODES.AI_CHAT_SESSION_CLOSED,
  ERROR_CODES.VALIDATION_FAILED,
]);

export function chatEngineUrl(path: string): string {
  return `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}${path}`;
}

export async function fetchChatEngine(
  url: string,
  init: RequestInit,
  requestId: string,
  timeoutMs: number,
  scope: string,
): Promise<Response | NextResponse> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        'x-request-id': requestId,
      },
      signal: ac.signal,
    });
  } catch (err) {
    log.warn(scope, 'upstream fetch failed', {
      requestId,
      err: serializeError(err),
      upstream: url,
    });
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: 'ai-engine 不可达',
      requestId,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function readUpstreamJson(
  response: Response,
  requestId: string,
): Promise<unknown | NextResponse> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: 'ai-engine 返回非 JSON',
      requestId,
    });
  }

  if (response.ok) return body;

  const upstream = body as {
    code?: string;
    message?: string;
    requestId?: string;
    request_id?: string;
    details?: unknown;
  };
  const code = CHAT_ERROR_CODES.has(upstream.code ?? '')
    ? (upstream.code as ErrorCode)
    : ERROR_CODES.AI_ENGINE_UNAVAILABLE;
  return toApiErrorResponse({
    code,
    message: upstream.message ?? `ai-engine 返回 ${response.status}`,
    requestId: upstream.requestId ?? upstream.request_id ?? requestId,
    // W9 安全复审修订：此前 upstream.details 原样透传，若 ai-engine
    // 内网异常时带堆栈/路径，这些信息会泄露给客户端。已改为只记录日志，
    // 不再包含在客户端响应里。
  });
}

export function chatSessionOwner(session: UpstreamChatSession): string | null {
  return session.user_id ?? session.userId ?? null;
}

export function chatSessionNotFound(requestId: string): NextResponse {
  return toApiErrorResponse({
    code: ERROR_CODES.AI_CHAT_SESSION_NOT_FOUND,
    message: '会话不存在',
    requestId,
  });
}

export function publicChatSession(session: UpstreamChatSession) {
  return {
    sessionId: session.session_id,
    status: session.status,
    createdAt: session.created_at,
    ...(session.updated_at ? { updatedAt: session.updated_at } : {}),
    seedSnapshot: {
      id: session.seed_snapshot.id,
      title: session.seed_snapshot.title,
      url: session.seed_snapshot.url,
      body: session.seed_snapshot.body,
      interpretation: session.seed_snapshot.interpretation,
      summaryDate: session.seed_snapshot.summary_date,
      tags: session.seed_snapshot.tags,
      originalMarkdown: session.seed_snapshot.original_markdown,
      originalKind: session.seed_snapshot.original_kind,
    },
    ...(session.message_count !== undefined ? { messageCount: session.message_count } : {}),
    ...(session.messages
      ? {
          messages: session.messages.map(publicChatMessage),
        }
      : {}),
  };
}

export function publicChatMessage(message: UpstreamChatMessage) {
  return {
    id: message.message_id ?? message.id ?? '',
    role: message.role,
    content: message.content,
    sources: message.sources_json,
    latencyMs: message.latency_ms,
    tokensIn: message.tokens_in,
    tokensOut: message.tokens_out,
    costCents: message.cost_cents,
    createdAt: message.created_at,
  };
}
