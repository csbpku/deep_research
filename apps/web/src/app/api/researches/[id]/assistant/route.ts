import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { apiHandler, parseBody } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { prisma } from '../../../../../lib/db';
import { getWebEnv } from '../../../../../lib/env';
import { fetchAiEngine } from '../../../../../lib/ai-bff/fetch-ai-engine';
import { log, withRequestId } from '../../../../../lib/log';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { ERROR_CODES } from '@deep-research/shared/errors';

const Input = z.object({
  operation: z.enum(['rewrite', 'summarize', 'counterpoint', 'fact_check', 'conclusion_check']),
  selection: z.object({ quote: z.string().min(1).max(4000), startOffset: z.number().int().min(0), endOffset: z.number().int().min(0), contentHash: z.string().regex(/^[a-f0-9]{64}$/u) }).optional(),
  instruction: z.string().max(2000).optional(),
});

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req); if (user instanceof NextResponse) return user;
  const { id } = await ctx.params;
  const parsed = z.object({ id: z.string().uuid() }).safeParse({ id });
  if (!parsed.success) return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: 'id 无效', requestId });
  const input = await parseBody(req, Input); if (input instanceof NextResponse) return input;
  const research = await prisma.research.findUnique({ where: { id }, select: { id: true, title: true, body: true, status: true, authorId: true, researchSources: { select: { id: true, title: true, canonicalKey: true, description: true, sourceRef: true } } } });
  if (!research || research.authorId !== user.id) return toApiErrorResponse({ code: ERROR_CODES.PERMISSION_DENIED, message: '只能操作自己的调研草稿', requestId });
  const selection = input.selection;
  if (selection) {
    if (selection.endOffset <= selection.startOffset || selection.endOffset > research.body.length) {
      return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '选文范围无效', requestId });
    }
    const currentHash = createHash('sha256').update(research.body).digest('hex');
    const selectedQuote = research.body.slice(selection.startOffset, selection.endOffset).trim();
    if (currentHash !== selection.contentHash || selectedQuote !== selection.quote.trim()) {
      return toApiErrorResponse({ code: ERROR_CODES.VALIDATION_FAILED, message: '选文已变化，请重新选择后重试', requestId });
    }
  }
  const startedAt = Date.now();
  const upstream = await fetchAiEngine<{ operation: string; original: string; suggestion: string | null; rationale: string; claims: unknown[]; warnings: string[]; metrics?: { token_input_total?: number; token_output_total?: number; cost_cents?: number } }>({
    url: `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/research-assistant`, method: 'POST', timeoutMs: 30_000, requestId, context: 'ai.bff.research-assistant',
    body: {
      operation: input.operation,
      // Keep the synchronous assistant within the engine's context contract.
      body: research.body.slice(0, 30000),
      topic: research.title,
      instruction: input.instruction,
      sources: research.researchSources,
      selection: input.selection ? {
        quote: input.selection.quote,
        start_offset: input.selection.startOffset,
        end_offset: input.selection.endOffset,
        content_hash: input.selection.contentHash,
      } : undefined,
    },
  });
  if (!upstream.ok) {
    log.warn('research.assistant', 'assistant request failed', { requestId, operation: input.operation, durationMs: Date.now() - startedAt, code: upstream.code });
    return toApiErrorResponse({ code: upstream.code, message: upstream.message, requestId: upstream.requestId, details: upstream.details });
  }
  log.info('research.assistant', 'assistant request completed', {
    requestId,
    operation: input.operation,
    durationMs: Date.now() - startedAt,
    tokenInputTotal: upstream.body.metrics?.token_input_total ?? 0,
    tokenOutputTotal: upstream.body.metrics?.token_output_total ?? 0,
    costCents: upstream.body.metrics?.cost_cents ?? 0,
  });
  return NextResponse.json(upstream.body);
});
