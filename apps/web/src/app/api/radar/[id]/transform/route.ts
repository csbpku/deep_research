import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import { apiHandler, parseBody } from '@/lib/api-handler';
import { getCurrentUser } from '@/lib/auth/session';
import { fetchAiEngine } from '@/lib/ai-bff/fetch-ai-engine';
import { prisma } from '@/lib/db';
import { toApiErrorResponse } from '@/lib/errors';
import { getWebEnv } from '@/lib/env';
import { withRequestId } from '@/lib/log';
import { RadarIdParam } from '@/lib/schemas';
import { ERROR_CODES } from '@deep-research/shared/errors';

const TransformInput = z.object({
  mode: z.enum(['translate', 'ai_reading']),
  language: z.string().trim().min(2).max(16).default('zh-CN'),
});

type CacheEntry = {
  sourceHash: string;
  language: string;
  content: string;
  createdAt: string;
};

const anonymousHits = new Map<string, { windowStartedAt: number; count: number }>();
const ANONYMOUS_LIMIT = 12;
const ANONYMOUS_WINDOW_MS = 60_000;

function clientKey(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'anonymous';
}

function allowAnonymous(req: NextRequest): boolean {
  const now = Date.now();
  const key = clientKey(req);
  const current = anonymousHits.get(key);
  if (!current || now - current.windowStartedAt >= ANONYMOUS_WINDOW_MS) {
    anonymousHits.set(key, { windowStartedAt: now, count: 1 });
    return true;
  }
  if (current.count >= ANONYMOUS_LIMIT) return false;
  current.count += 1;
  return true;
}

function sourceHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function readCache(value: unknown, mode: string, language: string): CacheEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cache = (value as Record<string, unknown>).readingCache;
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return null;
  const raw = (cache as Record<string, unknown>)[`${mode}:${language}`];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (
    typeof entry.sourceHash !== 'string'
    || typeof entry.language !== 'string'
    || typeof entry.content !== 'string'
  ) return null;
  return {
    sourceHash: entry.sourceHash,
    language: entry.language,
    content: entry.content,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
  };
}

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await getCurrentUser();
  if (!user && !allowAnonymous(req)) {
    return toApiErrorResponse({
      code: ERROR_CODES.UPSTREAM_RATE_LIMITED,
      message: '匿名阅读请求过于频繁，请稍后再试',
      requestId,
    });
  }

  const parsedId = RadarIdParam.safeParse(await ctx.params);
  if (!parsedId.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: parsedId.error.flatten(),
    });
  }
  const body = await parseBody(req, TransformInput);
  if (body instanceof NextResponse) return body;

  const summary = await prisma.summary.findUnique({
    where: { id: parsedId.data.id },
    select: {
      id: true,
      title: true,
      body: true,
      originalMarkdown: true,
      originalMeta: true,
      source: true,
      syncRunId: true,
      shareSource: { select: { status: true } },
    },
  });
  const visible = summary && (
    (summary.source === 'daily' && summary.syncRunId !== null)
    || (summary.source === 'user' && summary.shareSource?.status === 'approved')
  );
  if (!visible) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '雷达候选不存在',
      requestId,
    });
  }

  const content = (summary.originalMarkdown || summary.body || '').trim();
  if (!content) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '当前雷达没有可处理的正文',
      requestId,
    });
  }
  const hash = sourceHash(content);
  const cached = readCache(summary.originalMeta, body.mode, body.language);
  if (cached?.sourceHash === hash) {
    return NextResponse.json({
      mode: body.mode,
      language: body.language,
      sourceHash: hash,
      content: cached.content,
      cached: true,
    });
  }

  const instruction = body.mode === 'translate'
    ? `将以下 Markdown 完整翻译为 ${body.language}。保留标题、列表、表格、代码块、链接和段落结构，只返回翻译后的 Markdown。`
    : '生成一份面向工程师的 AI 阅读导读：先给出 3-5 条关键结论，再列出证据、限制和需要进一步验证的问题。只返回 Markdown，不要虚构原文没有的事实。';

  const env = getWebEnv();
  const result = await fetchAiEngine<{
    suggestion?: string;
  }>({
    url: `${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/research-assistant`,
    requestId,
    method: 'POST',
    timeoutMs: 120_000,
    retry: false,
    headers: env.INTERNAL_SERVICE_TOKEN ? { 'x-internal-token': env.INTERNAL_SERVICE_TOKEN } : {},
    body: {
      operation: body.mode === 'translate' ? 'rewrite' : 'summarize',
      body: content.slice(0, 30_000),
      topic: summary.title,
      instruction,
    },
    context: `radar.${body.mode}`,
  });
  if (!result.ok || !result.body.suggestion?.trim()) {
    return toApiErrorResponse({
      code: result.ok ? ERROR_CODES.AI_ENGINE_UNAVAILABLE : result.code,
      message: result.ok ? 'AI 阅读结果为空' : result.message,
      requestId,
      details: result.ok ? undefined : result.details,
    });
  }

  const entry: CacheEntry = {
    sourceHash: hash,
    language: body.language,
    content: result.body.suggestion.trim(),
    createdAt: new Date().toISOString(),
  };
  const meta = summary.originalMeta && typeof summary.originalMeta === 'object' && !Array.isArray(summary.originalMeta)
    ? summary.originalMeta as Record<string, unknown>
    : {};
  const oldCache = meta.readingCache && typeof meta.readingCache === 'object' && !Array.isArray(meta.readingCache)
    ? meta.readingCache as Record<string, unknown>
    : {};
  const nextMeta = {
    ...meta,
    readingCache: {
      ...oldCache,
      [`${body.mode}:${body.language}`]: entry,
    },
  } as Prisma.InputJsonValue;
  await prisma.summary.update({
    where: { id: summary.id },
    data: { originalMeta: nextMeta },
  });

  return NextResponse.json({
    mode: body.mode,
    language: body.language,
    sourceHash: hash,
    content: entry.content,
    cached: false,
  });
});
