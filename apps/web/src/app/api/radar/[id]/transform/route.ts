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
  selection: z.string().trim().min(1).max(12000).optional(),
});

type CacheEntry = {
  sourceHash: string;
  language: string;
  content: string;
  createdAt: string;
  sourceChars?: number;
  processedChars?: number;
  sourceTruncated?: boolean;
  guideVersion?: number;
  failedChunkIndexes?: number[];
  totalChunks?: number;
  truncatedChunkIndexes?: number[];
  resolvedOutlineCount?: number;
  outlineCount?: number;
};

type RadarGuideV2 = {
  version: 2;
  summary?: string;
  outline?: Array<{
    heading?: string;
    takeaway?: string;
    quote?: string;
    sourceBlockIndex?: number;
    sourceBlockId?: string;
    anchorStatus?: 'resolved' | 'unresolved';
  }>;
  keyTakeaways?: Array<{ claim?: string; whyItMatters?: string; evidence?: string }>;
  implications?: string[];
  caveats?: string[];
  openQuestions?: string[];
  highlights?: Array<{ quote?: string; rationale?: string }>;
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

// Translation output is usually close to the source length. Keep input
// chunks small enough that a complete translation fits the model output
// budget; a successful HTTP response is not proof of a complete response.
const MAX_CHUNK_CHARS = 8_000;

function splitIntoChunks(markdown: string, maxChars = MAX_CHUNK_CHARS): string[] {
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
    if (isHeading && current.join('\n').length > maxChars) {
      flush();
    }
    current.push(line);
    if (current.join('\n').length > maxChars) {
      flush();
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [markdown];
}

function readCache(value: unknown, cacheKey: string): CacheEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cache = (value as Record<string, unknown>).readingCache;
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return null;
  const raw = (cache as Record<string, unknown>)[cacheKey];
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
    sourceChars: typeof entry.sourceChars === 'number' ? entry.sourceChars : undefined,
    processedChars: typeof entry.processedChars === 'number' ? entry.processedChars : undefined,
    sourceTruncated: entry.sourceTruncated === true,
    guideVersion: typeof entry.guideVersion === 'number' ? entry.guideVersion : undefined,
    failedChunkIndexes: Array.isArray(entry.failedChunkIndexes)
      ? entry.failedChunkIndexes.filter((item): item is number => typeof item === 'number')
      : undefined,
    totalChunks: typeof entry.totalChunks === 'number' ? entry.totalChunks : undefined,
    truncatedChunkIndexes: Array.isArray(entry.truncatedChunkIndexes)
      ? entry.truncatedChunkIndexes.filter((item): item is number => typeof item === 'number')
      : undefined,
    resolvedOutlineCount: typeof entry.resolvedOutlineCount === 'number' ? entry.resolvedOutlineCount : undefined,
    outlineCount: typeof entry.outlineCount === 'number' ? entry.outlineCount : undefined,
  };
}

function splitSourceBlocks(content: string): string[] {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: 'backtick' | 'tilde' | null = null;
  let mathBlock = false;
  const flush = () => {
    const block = current.join('\n').trim();
    if (block) blocks.push(block);
    current = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const kind = fenceMatch[1]!.startsWith('`') ? 'backtick' : 'tilde';
      if (fence === null) fence = kind;
      else if (fence === kind) fence = null;
      current.push(line);
      continue;
    }
    if (trimmed.startsWith('$$')) {
      if ((trimmed.match(/\$\$/gu) ?? []).length % 2 === 1) mathBlock = !mathBlock;
      current.push(line);
      continue;
    }
    if (!trimmed && fence === null && !mathBlock) flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

function normalizeAnchorText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\\(?:textbf|textit|emph|texttt)\{([^{}\n]*)\}/gu, '$1')
    .replace(/\\href\{[^{}\n]+\}\{([^{}\n]*)\}/gu, '$1')
    .replace(/\\url\{([^{}\n]*)\}/gu, '$1')
    .replace(/[\\*_`~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function anchorMatchesBlock(block: string, quote: string): boolean {
  const normalizedBlock = normalizeAnchorText(block);
  const normalizedQuote = normalizeAnchorText(quote);
  // A navigation link is only trustworthy when the quoted evidence is
  // literally present in one rendered source block. Similarity/token
  // matching can jump to the wrong paragraph when technical prose repeats
  // vocabulary, so unresolved is safer than an incorrect location.
  return normalizedQuote.length >= 18 && normalizedBlock.includes(normalizedQuote);
}

function resolveGuideAnchors(guide: RadarGuideV2, content: string): {
  guide: RadarGuideV2;
  outlineCount: number;
  resolvedOutlineCount: number;
} {
  const blocks = splitSourceBlocks(content);
  const outline = guide.outline ?? [];
  let resolvedOutlineCount = 0;
  const resolved = outline.map((item) => {
    const quote = typeof item.quote === 'string' ? item.quote.trim() : '';
    const blockIndex = quote ? blocks.findIndex((block) => anchorMatchesBlock(block, quote)) : -1;
    if (blockIndex < 0) {
      return { ...item, sourceBlockIndex: undefined, sourceBlockId: undefined, anchorStatus: 'unresolved' as const };
    }
    resolvedOutlineCount += 1;
    return {
      ...item,
      sourceBlockIndex: blockIndex,
      sourceBlockId: `radar-source-block-${blockIndex}`,
      anchorStatus: 'resolved' as const,
    };
  });
  return {
    guide: { ...guide, outline: resolved },
    outlineCount: outline.length,
    resolvedOutlineCount,
  };
}

function normalizeGuide(value: unknown): RadarGuideV2 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const legacyConclusions = Array.isArray(raw.conclusions) ? raw.conclusions : [];
  const legacyLimitations = Array.isArray(raw.limitations) ? raw.limitations : [];
  const guide: RadarGuideV2 = {
    version: 2,
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    outline: Array.isArray(raw.outline) ? raw.outline as RadarGuideV2['outline'] : [],
    keyTakeaways: Array.isArray(raw.keyTakeaways)
      ? raw.keyTakeaways as RadarGuideV2['keyTakeaways']
      : legacyConclusions.map((item) => {
        const entry = item as Record<string, unknown>;
        return { claim: typeof entry.claim === 'string' ? entry.claim : undefined, evidence: typeof entry.evidence === 'string' ? entry.evidence : undefined };
      }),
    implications: Array.isArray(raw.implications) ? raw.implications.filter((item): item is string => typeof item === 'string') : [],
    caveats: Array.isArray(raw.caveats)
      ? raw.caveats.filter((item): item is string => typeof item === 'string')
      : legacyLimitations.filter((item): item is string => typeof item === 'string'),
    openQuestions: Array.isArray(raw.openQuestions) ? raw.openQuestions.filter((item): item is string => typeof item === 'string') : [],
    highlights: Array.isArray(raw.highlights) ? raw.highlights as RadarGuideV2['highlights'] : [],
  };
  return guide;
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

  const fullContent = (summary.originalMarkdown || summary.body || '').trim();
  const content = body.selection?.trim() || fullContent;
  const hasSelection = Boolean(body.selection?.trim());
  if (!fullContent) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '当前雷达没有可处理的正文',
      requestId,
    });
  }
  const hash = sourceHash(content);
  // M6: translate 走分块缓存；ai_reading 使用 v4 锚点协议，避免继续命中
  // 旧的、未经服务端验证的地图。
  if (body.mode === 'translate' && !hasSelection) {
    const chunks = splitIntoChunks(content);
    const cacheObj = summary.originalMeta && typeof summary.originalMeta === 'object' && !Array.isArray(summary.originalMeta)
      ? (summary.originalMeta as Record<string, unknown>).readingCache
      : null;
    const cacheMap = cacheObj && typeof cacheObj === 'object' && !Array.isArray(cacheObj)
      ? cacheObj as Record<string, unknown>
      : {};
    const cachedChunks: Array<{ index: number; content: string; sourceChars?: number; translatedChars?: number; complete?: boolean; truncated?: boolean }> = [];
    let allHit = chunks.length > 0;
    for (let i = 0; i < chunks.length; i++) {
      const raw = cacheMap[`translate:${body.language}:chunk.${i}`] as Record<string, unknown> | undefined;
      if (raw && typeof raw.content === 'string' && raw.sourceHash === sourceHash(chunks[i])) {
        cachedChunks.push({
          index: i,
          content: raw.content,
          sourceChars: typeof raw.sourceChars === 'number' ? raw.sourceChars : chunks[i].length,
          translatedChars: typeof raw.translatedChars === 'number' ? raw.translatedChars : raw.content.length,
          complete: raw.complete !== false,
          truncated: raw.truncated === true,
        });
      } else {
        allHit = false;
      }
    }
    if (allHit) {
      return NextResponse.json({
        mode: body.mode,
        language: body.language,
        sourceHash: hash,
        chunks: cachedChunks,
        complete: cachedChunks.every((chunk) => chunk.complete !== false && !chunk.truncated),
        totalChunks: chunks.length,
        cached: true,
      });
    }
  } else if (!hasSelection) {
    const cached = readCache(summary.originalMeta, `ai_reading:v4:${body.language}`);
    if (cached?.sourceHash === hash) {
      let guide: unknown;
      try {
        guide = JSON.parse(cached.content);
      } catch {
        guide = undefined;
      }
      const normalizedGuide = normalizeGuide(guide);
      const resolved = normalizedGuide ? resolveGuideAnchors(normalizedGuide, fullContent) : null;
      return NextResponse.json({
        mode: body.mode,
        language: body.language,
        sourceHash: hash,
        guide: resolved?.guide,
        content: guide ? undefined : cached.content,
        sourceChars: cached.sourceChars,
        processedChars: cached.processedChars,
        sourceTruncated: cached.sourceTruncated,
        complete: cached.failedChunkIndexes?.length ? false : true,
        failedChunkIndexes: cached.failedChunkIndexes ?? [],
        totalChunks: cached.totalChunks ?? 1,
        guideVersion: cached.guideVersion ?? 4,
        coverage: {
          sourceChars: cached.sourceChars ?? fullContent.length,
          processedChars: cached.processedChars ?? fullContent.length,
          complete: !(cached.failedChunkIndexes?.length),
          outlineCount: resolved?.outlineCount ?? cached.outlineCount ?? 0,
          resolvedOutlineCount: resolved?.resolvedOutlineCount ?? cached.resolvedOutlineCount ?? 0,
        },
        cached: true,
      });
    }
  }

  const env = getWebEnv();
  const aiEngineUrl = `${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/research-assistant`;
  const headers: Record<string, string> | undefined = env.INTERNAL_SERVICE_TOKEN
    ? { 'x-internal-token': env.INTERNAL_SERVICE_TOKEN }
    : undefined;

  // 选区解释是一个即时阅读动作，不应走整篇文章的结构化导读流程。
  // 给模型少量邻近上下文，并明确要求解释术语在本文中的含义，避免只返回“这是一个术语”的空泛结果。
  if (body.mode === 'ai_reading' && hasSelection) {
    const quoteIndex = fullContent.indexOf(content);
    const contextStart = quoteIndex >= 0 ? Math.max(0, quoteIndex - 3500) : 0;
    const contextEnd = quoteIndex >= 0 ? Math.min(fullContent.length, quoteIndex + content.length + 3500) : Math.min(fullContent.length, 7000);
    const context = fullContent.slice(contextStart, contextEnd);
    const instruction = '解释选中的术语或片段。先给出清晰定义，再结合上下文说明它在本文中的具体含义、涉及的变量/机制以及为什么重要；如果是公式或指标，说明如何理解。不要只复述“这是一个术语”，也不要因为信息有限就直接拒答。只返回面向读者的解释文本。';
    const explainBody = { operation: 'explain', body: `上下文：\n${context}\n\n选中内容：\n${content}`, topic: summary.title, instruction };
    let result = await fetchAiEngine<{ suggestion?: string }>({
      url: aiEngineUrl,
      requestId,
      method: 'POST',
      timeoutMs: 45_000,
      retry: false,
      headers,
      body: explainBody,
      context: 'radar.selection.explain',
    });
    // Older long-running AI engine processes may still expose the pre-explain
    // operation schema. The instruction itself is enough to preserve the
    // semantics, so fall back to the compatible rewrite operation instead of
    // surfacing Pydantic's raw pattern error to the reader.
    if (!result.ok && result.message.includes('String should match pattern')) {
      result = await fetchAiEngine<{ suggestion?: string }>({
        url: aiEngineUrl,
        requestId,
        method: 'POST',
        timeoutMs: 45_000,
        retry: false,
        headers,
        body: { ...explainBody, operation: 'rewrite' },
        context: 'radar.selection.explain.compat',
      });
    }
    if (!result.ok) {
      return toApiErrorResponse({ code: result.code, message: result.message, requestId, details: result.details });
    }
    if (!result.body.suggestion?.trim()) {
      return toApiErrorResponse({ code: ERROR_CODES.AI_ENGINE_UNAVAILABLE, message: '解释结果为空，请重试', requestId });
    }
    return NextResponse.json({ mode: body.mode, language: body.language, content: result.body.suggestion.trim(), selected: true, promptLabel: '术语定义 + 原文上下文 + 在本文中的作用' });
  }

  // ── translate：分块翻译（M6） ──
  if (body.mode === 'translate') {
    const instruction = `将以下 Markdown 完整翻译为 ${body.language}。保留标题、列表、表格、代码块、链接和段落结构，只返回翻译后的 Markdown。`;
    const chunks = splitIntoChunks(content);
    const translated: Array<{ index: number; content: string; sourceChars: number; translatedChars: number; complete: boolean; truncated: boolean }> = [];
    const failedChunkIndexes: number[] = [];
    const truncatedChunkIndexes: number[] = [];
    const results = await Promise.all(chunks.map(async (chunk, i) => {
      const r = await fetchAiEngine<{ suggestion?: string; truncated?: boolean; finishReason?: string }>({
        url: aiEngineUrl,
        requestId,
        method: 'POST',
        timeoutMs: 120_000,
        retry: false,
        headers,
        body: { operation: 'rewrite', body: chunk, topic: summary.title, instruction },
        context: `radar.translate.chunk.${i}`,
      });
      if (!r.ok || !r.body.suggestion?.trim() || r.body.truncated === true) {
        return { index: i, failed: true, truncated: r.ok && r.body.truncated === true };
      }
      const translatedContent = r.body.suggestion.trim();
      return { index: i, failed: false, truncated: false, content: translatedContent, sourceChars: chunk.length, translatedChars: translatedContent.length };
    }));
    for (const result of results) {
      if (result.failed) {
        // 单块失败：继续处理后续块，避免一次失败导致后半篇全文消失。
        failedChunkIndexes.push(result.index);
        if (result.truncated) truncatedChunkIndexes.push(result.index);
      } else {
        translated.push({ index: result.index, content: result.content!, sourceChars: result.sourceChars!, translatedChars: result.translatedChars!, complete: true, truncated: false });
      }
    }
    translated.sort((a, b) => a.index - b.index);

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
        sourceChars: t.sourceChars,
        processedChars: t.translatedChars,
        sourceTruncated: false,
        createdAt: new Date().toISOString(),
      };
    }
    if (!hasSelection) {
      await prisma.summary.update({
        where: { id: summary.id },
        data: {
          originalMeta: { ...meta, readingCache: nextCache } as Prisma.InputJsonValue,
        },
      });
    }

    return NextResponse.json({
      mode: body.mode,
      language: body.language,
      sourceHash: hash,
      chunks: translated,
      complete: translated.length === chunks.length,
      totalChunks: chunks.length,
      failedChunkIndexes,
      truncatedChunkIndexes,
      cached: false,
      selected: hasSelection,
    });
  }

  // ── ai_reading：v2 结构化 guide，长文走 section → synthesis ──
  // Keep the structural split threshold so long papers are processed in
  // resilient sections. The engine input ceiling is now higher; this is not
  // a reader-visible truncation.
  // Keep sectioning for provider stability, but do not silently discard the
  // tail of a long paper during direct/synthesis guide generation.
  const GUIDE_MAX_DIRECT_CHARS = 240_000;
  const GUIDE_SECTION_CHARS = 48_000;
  const guideChunks = content.length > GUIDE_MAX_DIRECT_CHARS
    ? splitIntoChunks(content, GUIDE_SECTION_CHARS)
    : [content];
  const failedChunkIndexes: number[] = [];
  const sectionNotes: Array<{ index: number; guide: RadarGuideV2 }> = [];
  let guide: RadarGuideV2 | null = null;
  let suggestion = '';

  if (guideChunks.length === 1) {
    const result = await fetchAiEngine<{ suggestion?: string; guide?: unknown }>({
      url: aiEngineUrl,
      requestId,
      method: 'POST',
      timeoutMs: 120_000,
      retry: false,
      headers,
      body: { operation: 'guide', body: guideChunks[0], topic: summary.title, summaryId: summary.id },
      context: 'radar.ai_reading.v2',
    });
    if (!result.ok) {
      return toApiErrorResponse({ code: result.code, message: result.message, requestId, details: result.details });
    }
    guide = normalizeGuide(result.body.guide);
    suggestion = result.body.suggestion?.trim() ?? '';
  } else {
    for (let i = 0; i < guideChunks.length; i++) {
      const result = await fetchAiEngine<{ guide?: unknown }>({
        url: aiEngineUrl,
        requestId,
        method: 'POST',
        timeoutMs: 120_000,
        retry: false,
        headers,
        body: { operation: 'guide_section', body: guideChunks[i], topic: summary.title, summaryId: summary.id },
        context: `radar.ai_reading.v2.section.${i}`,
      });
      const sectionGuide = result.ok ? normalizeGuide(result.body.guide) : null;
      if (!sectionGuide) {
        failedChunkIndexes.push(i);
      } else {
        sectionNotes.push({ index: i, guide: sectionGuide });
      }
    }

    if (sectionNotes.length > 0) {
      // Keep every successful section represented while compacting prose so
      // the synthesis request does not silently drop the tail of a long
      // article when there are many sections.
      const synthesisNotes = sectionNotes.map(({ index, guide: item }) => ({
        index,
        outline: (item.outline ?? []).slice(0, 2).map((entry) => ({
          heading: entry.heading?.slice(0, 180),
          takeaway: entry.takeaway?.slice(0, 400),
          quote: entry.quote?.slice(0, 700),
        })),
        keyTakeaways: (item.keyTakeaways ?? []).slice(0, 2).map((entry) => ({
          claim: entry.claim?.slice(0, 300),
          whyItMatters: entry.whyItMatters?.slice(0, 300),
          evidence: entry.evidence?.slice(0, 700),
        })),
        caveats: (item.caveats ?? []).slice(0, 2).map((entry) => entry.slice(0, 240)),
        implications: (item.implications ?? []).slice(0, 2).map((entry) => entry.slice(0, 240)),
        openQuestions: (item.openQuestions ?? []).slice(0, 2).map((entry) => entry.slice(0, 240)),
        highlights: (item.highlights ?? []).slice(0, 2).map((entry) => ({
          quote: entry.quote?.slice(0, 700),
          rationale: entry.rationale?.slice(0, 240),
        })),
      }));
      const synthesisBody = JSON.stringify(synthesisNotes);
      const synthesis = await fetchAiEngine<{ guide?: unknown }>({
        url: aiEngineUrl,
        requestId,
        method: 'POST',
        timeoutMs: 120_000,
        retry: false,
        headers,
        body: { operation: 'guide_synthesis', body: synthesisBody, topic: summary.title, summaryId: summary.id },
        context: 'radar.ai_reading.v2.synthesis',
      });
      guide = synthesis.ok ? normalizeGuide(synthesis.body.guide) : null;
      if (!guide) {
        guide = {
          version: 2,
          outline: sectionNotes.flatMap(({ guide: item }) => item.outline ?? []).slice(0, 8),
          keyTakeaways: sectionNotes.flatMap(({ guide: item }) => item.keyTakeaways ?? []).slice(0, 5),
          implications: sectionNotes.flatMap(({ guide: item }) => item.implications ?? []).slice(0, 3),
          caveats: sectionNotes.flatMap(({ guide: item }) => item.caveats ?? []).slice(0, 4),
          openQuestions: sectionNotes.flatMap(({ guide: item }) => item.openQuestions ?? []).slice(0, 3),
          highlights: sectionNotes.flatMap(({ guide: item }) => item.highlights ?? []).slice(0, 6),
        };
      }
    }
  }

  if (!guide && !suggestion) {
    return toApiErrorResponse({ code: ERROR_CODES.AI_ENGINE_UNAVAILABLE, message: 'AI 阅读结果为空', requestId });
  }

  const processedChars = guideChunks.length === 1
    ? content.length
    : guideChunks.reduce((total, chunk, index) => failedChunkIndexes.includes(index) ? total : total + chunk.length, 0);
  const cachedContent = guide ? JSON.stringify(guide) : suggestion;

  const resolvedGuide = guide ? resolveGuideAnchors(guide, fullContent) : null;
  guide = resolvedGuide?.guide ?? guide;
  const entry: CacheEntry = {
    sourceHash: hash,
    language: body.language,
    content: cachedContent,
    createdAt: new Date().toISOString(),
    sourceChars: content.length,
    processedChars,
    sourceTruncated: false,
    guideVersion: 4,
    failedChunkIndexes,
    totalChunks: guideChunks.length,
    outlineCount: resolvedGuide?.outlineCount ?? 0,
    resolvedOutlineCount: resolvedGuide?.resolvedOutlineCount ?? 0,
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
      [`ai_reading:v4:${body.language}`]: entry,
    },
  } as Prisma.InputJsonValue;
  if (!hasSelection) {
    await prisma.summary.update({
      where: { id: summary.id },
      data: { originalMeta: nextMeta },
    });
  }

  return NextResponse.json({
    mode: body.mode,
    language: body.language,
    sourceHash: hash,
    guide: guide ?? undefined,
    content: guide ? undefined : cachedContent,
    sourceChars: content.length,
    processedChars,
    sourceTruncated: false,
    complete: failedChunkIndexes.length === 0,
    failedChunkIndexes,
    totalChunks: guideChunks.length,
    guideVersion: 4,
    coverage: {
      sourceChars: content.length,
      processedChars,
      complete: failedChunkIndexes.length === 0,
      outlineCount: resolvedGuide?.outlineCount ?? 0,
      resolvedOutlineCount: resolvedGuide?.resolvedOutlineCount ?? 0,
    },
    cached: false,
    selected: hasSelection,
  });
});
