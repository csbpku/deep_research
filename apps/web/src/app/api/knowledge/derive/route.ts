import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiHandler, parseBody } from '../../../../lib/api-handler';
import { requireUser } from '../../../../lib/auth/session';
import { getWebEnv } from '../../../../lib/env';
import { fetchAiEngine } from '../../../../lib/ai-bff/fetch-ai-engine';
import { toApiErrorResponse } from '../../../../lib/errors';
import { withRequestId } from '../../../../lib/log';
import {
  KNOWLEDGE_SOURCE_KINDS,
  resolveKnowledgeSource,
} from '../../../../lib/knowledge-card';

const Input = z.object({
  sourceKind: z.enum(KNOWLEDGE_SOURCE_KINDS),
  messageId: z.string().uuid(),
}).strict();

interface KnowledgeCardPreview {
  title: string;
  body: string;
  conclusion: string;
  tags: string[];
}

export const POST = apiHandler<[NextRequest]>(async (req) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const input = await parseBody(req, Input);
  if (input instanceof NextResponse) return input;
  const source = await resolveKnowledgeSource(input.sourceKind, input.messageId, user.id);
  if (!source) {
    return toApiErrorResponse({
      code: 'PERMISSION_DENIED' as const,
      message: '只能提炼自己会话中的 AI 回答',
      requestId,
    });
  }

  const env = getWebEnv();
  const upstream = await fetchAiEngine<{
    card?: Partial<KnowledgeCardPreview> | null;
    warnings?: string[];
  }>({
    url: `${env.AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/research-assistant`,
    requestId,
    method: 'POST',
    retry: false,
    timeoutMs: 45_000,
    headers: env.INTERNAL_SERVICE_TOKEN
      ? { 'x-internal-token': env.INTERNAL_SERVICE_TOKEN }
      : undefined,
    context: 'knowledge-card.derive',
    body: {
      operation: 'knowledge_card',
      body: source.content,
      topic: source.topic,
      sources: source.sources,
    },
  });
  if (!upstream.ok) {
    return toApiErrorResponse({
      code: upstream.code,
      message: upstream.message,
      requestId: upstream.requestId,
      details: upstream.details,
    });
  }

  const raw = upstream.body.card;
  const preview: KnowledgeCardPreview | null = raw
    && typeof raw.title === 'string'
    && typeof raw.body === 'string'
    && typeof raw.conclusion === 'string'
    && Array.isArray(raw.tags)
    ? {
        title: raw.title.trim().slice(0, 300),
        body: raw.body.trim().slice(0, 50_000),
        conclusion: raw.conclusion.trim().slice(0, 2_000),
        tags: raw.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean).slice(0, 10),
      }
    : null;
  if (!preview?.title || !preview.body) {
    return toApiErrorResponse({
      code: 'AI_ENGINE_UNAVAILABLE' as const,
      message: '知识卡片预览生成失败，请重试',
      requestId,
      details: { warnings: upstream.body.warnings ?? [] },
    });
  }

  return NextResponse.json({
    preview,
    source: {
      kind: input.sourceKind,
      messageId: source.messageId,
      count: source.sources.length,
    },
  });
});
