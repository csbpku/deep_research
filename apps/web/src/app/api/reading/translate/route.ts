import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

import { ReadingTranslateInputSchema } from '@deep-research/shared/schemas';
import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { getWebEnv } from '../../../../lib/env';
import { fetchAiEngine } from '../../../../lib/ai-bff/fetch-ai-engine';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import { requireReadingUser } from '../../../../lib/reading-auth';

type EngineTranslation = { suggestion: string | null; metrics?: Record<string, unknown> };

const MAX_CONCURRENCY = 3;
const MAX_CACHE_ENTRIES = 512;
const translationCache = new Map<string, string>();

function cacheKey(input: { language: string; title: string; text: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({
      language: input.language,
      title: input.title,
      text: input.text,
      model: process.env.RESEARCH_ASSISTANT_LLM || 'default',
    }))
    .digest('hex');
}

function rememberTranslation(key: string, value: string): void {
  translationCache.delete(key);
  translationCache.set(key, value);
  while (translationCache.size > MAX_CACHE_ENTRIES) {
    const oldest = translationCache.keys().next().value;
    if (oldest === undefined) break;
    translationCache.delete(oldest);
  }
}

export const dynamic = 'force-dynamic';

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireReadingUser(req);
  if (user instanceof Response) return user;
  const input = await parseBody(req, ReadingTranslateInputSchema);
  if (input instanceof NextResponse) return input;

  const results: Array<{ id: string; text: string; sourceText: string; error?: string }> = [];
  for (let index = 0; index < input.blocks.length; index += MAX_CONCURRENCY) {
    const batch = input.blocks.slice(index, index + MAX_CONCURRENCY);
    const settled = await Promise.all(batch.map(async (block) => {
      const key = cacheKey({ language: input.language, title: input.title, text: block.text });
      const cached = translationCache.get(key);
      if (cached) return { id: block.id, text: cached, sourceText: block.text };
      const upstream = await fetchAiEngine<EngineTranslation>({
        url: `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/research-assistant`,
        method: 'POST',
        timeoutMs: 60_000,
        retry: true,
        signal: req.signal,
        requestId,
        context: 'reading.translate',
        body: {
          operation: 'translate',
          body: block.text,
          topic: input.title,
          instruction: `翻译为${input.language}。保留代码、专有名词、链接和原段落结构。`,
        },
      });
      if (upstream.ok && upstream.body.suggestion?.trim()) {
        const translated = upstream.body.suggestion.trim();
        rememberTranslation(key, translated);
        return { id: block.id, text: translated, sourceText: block.text };
      }
      return upstream.ok
        ? { id: block.id, text: '', sourceText: block.text, error: '翻译结果为空' }
        : { id: block.id, text: '', sourceText: block.text, error: upstream.message };
    }));
    results.push(...settled);
  }
  return NextResponse.json({ ok: true, translations: results, requestId });
});
