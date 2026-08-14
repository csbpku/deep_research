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

// M6: 翻译分块。ai-engine research_assistant 的 body max 30K，长论文（50K+）
// 会被硬截断。这里按 h2/h3 标题边界切块，每块 ≤ 24K（留 6K 给 instruction + prompt 包装）。
const MAX_CHUNK_CHARS = 24_000;

function splitIntoChunks(markdown: string): string[] {
  const lines = markdown.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join('\n').trim());
      current = [];
    }
  };

  for (const line of lines) {
    const isHeading = /^#{2,4}\s/u.test(line);
    if (isHeading && current.join('\n').length > MAX_CHUNK_CHARS) {
      flush();
    }
    current.push(line);
    if (current.join('\n').length > MAX_CHUNK_CHARS) {
      flush();
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [markdown];
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

  // M6: translate 走分块缓存（translate:{lang}:chunk.{i}），ai_reading 走单条（ai_reading:{lang}）。
  if (body.mode === 'translate') {
    const chunks = splitIntoChunks(content);
    const cacheObj = summary.originalMeta && typeof summary.originalMeta === 'object' && !Array.isArray(summary.originalMeta)
      ? (summary.originalMeta as Record<string, unknown>).readingCache
      : null;
    const cacheMap = cacheObj && typeof cacheObj === 'object' && !Array.isArray(cacheObj)
      ? cacheObj as Record<string, unknown>
      : {};
    const cachedChunks: Array<{ index: number; content: string }> = [];
    let allHit = chunks.length > 0;
    for (let i = 0; i < chunks.length; i++) {
      const raw = cacheMap[`translate:${body.language}:chunk.${i}`] as Record<string, unknown> | undefined;
      if (raw && typeof raw.content === 'string' && raw.sourceHash === sourceHash(chunks[i])) {
        cachedChunks.push({ index: i, content: raw.content });
      } else {
        allHit = false;
        break;
      }
    }
    if (allHit) {
      return NextResponse.json({
        mode: body.mode,
        language: body.language,
        sourceHash: hash,
        chunks: cachedChunks,
        complete: true,
        cached: true,
      });
    }
  } else {
    const cached = readCache(summary.originalMeta, 'ai_reading', body.language);
    if (cached?.sourceHash === hash) {
      let guide: unknown;
      try {
        guide = JSON.parse(cached.content);
      } catch {
        guide = undefined;
      }
      return NextResponse.json({
        mode: body.mode,
        language: body.language,
        sourceHash: hash,
        guide,
        cached: true,
      });
    }
  }

  const env = getWebEnv();
  const aiEngineUrl = `${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/research-assistant`;
  const headers: Record<string, string> | undefined = env.INTERNAL_SERVICE_TOKEN
    ? { 'x-internal-token': env.INTERNAL_SERVICE_TOKEN }
    : undefined;

  // ── translate：分块翻译（M6） ──
  if (body.mode === 'translate') {
    const instruction = `将以下 Markdown 完整翻译为 ${body.language}。保留标题、列表、表格、代码块、链接和段落结构，只返回翻译后的 Markdown。`;
    const chunks = splitIntoChunks(content);
    const translated: Array<{ index: number; content: string }> = [];
    for (let i = 0; i < chunks.length; i++) {
      const r = await fetchAiEngine<{ suggestion?: string }>({
        url: aiEngineUrl,
        requestId,
        method: 'POST',
        timeoutMs: 120_000,
        retry: false,
        headers,
        body: { operation: 'rewrite', body: chunks[i], topic: summary.title, instruction },
        context: `radar.translate.chunk.${i}`,
      });
      if (!r.ok || !r.body.suggestion?.trim()) {
        // 单块失败 → 返回已完成的块 + complete=false（降级到部分翻译）
        break;
      }
      translated.push({ index: i, content: r.body.suggestion.trim() });
    }

    // 缓存每块（readingCache.translate.{lang}.chunk.{i}）
    const meta = summary.originalMeta && typeof summary.originalMeta === 'object' && !Array.isArray(summary.originalMeta)
      ? summary.originalMeta as Record<string, unknown>
      : {};
    const oldCache = meta.readingCache && typeof meta.readingCache === 'object' && !Array.isArray(meta.readingCache)
      ? meta.readingCache as Record<string, unknown>
      : {};
    const nextCache = { ...oldCache };
    for (const t of translated) {
      nextCache[`translate:${body.language}:chunk.${t.index}`] = {
        sourceHash: sourceHash(chunks[t.index]),
        language: body.language,
        content: t.content,
        createdAt: new Date().toISOString(),
      };
    }
    await prisma.summary.update({
      where: { id: summary.id },
      data: {
        originalMeta: { ...meta, readingCache: nextCache } as Prisma.InputJsonValue,
      },
    });

    return NextResponse.json({
      mode: body.mode,
      language: body.language,
      sourceHash: hash,
      chunks: translated,
      complete: translated.length === chunks.length,
      cached: false,
    });
  }

  // ── ai_reading：结构化 guide（M5） ──
  const result = await fetchAiEngine<{
    suggestion?: string;
    guide?: {
      summary?: string;
      conclusions?: Array<{ claim?: string; evidence?: string }>;
      limitations?: string[];
      openQuestions?: string[];
      highlights?: Array<{ quote?: string; rationale?: string }>;
    } | null;
  }>({
    url: aiEngineUrl,
    requestId,
    method: 'POST',
    timeoutMs: 120_000,
    retry: false,
    headers,
    body: { operation: 'guide', body: content.slice(0, 30_000), topic: summary.title },
    context: 'radar.ai_reading',
  });

  // guide 为结构化 JSON；若 LLM 解析失败（guide=null）则降级到 suggestion markdown。
  if (!result.ok) {
    return toApiErrorResponse({
      code: result.code,
      message: result.message,
      requestId,
      details: result.details,
    });
  }

  const guide = result.body.guide ?? null;
  const suggestion = result.body.suggestion?.trim() ?? '';

  if (!guide && !suggestion) {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_ENGINE_UNAVAILABLE,
      message: 'AI 阅读结果为空',
      requestId,
    });
  }

  // 缓存：guide 可用时存结构化 JSON 字符串，否则存 markdown（降级）。
  const cachedContent = guide ? JSON.stringify(guide) : suggestion;

  const entry: CacheEntry = {
    sourceHash: hash,
    language: body.language,
    content: cachedContent,
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
      [`ai_reading:${body.language}`]: entry,
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
    guide: guide ?? undefined,
    content: guide ? undefined : cachedContent,
    cached: false,
  });
});
