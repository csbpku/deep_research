// SSE progress stream for AI research jobs.
// The job engine currently exposes snapshots, not token deltas. This route
// turns those snapshots into a low-latency progress stream for the UI while
// keeping the existing GET endpoint as the durable/fallback read path.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { ERROR_CODES } from '@deep-research/shared/errors';
import { apiHandler } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { withRequestId } from '../../../../../lib/log';
import { getWebEnv } from '../../../../../lib/env';
import { fetchAiEngine } from '../../../../../lib/ai-bff/fetch-ai-engine';

const IdParam = z.object({ jobId: z.string().uuid() });
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'partial']);

interface UpstreamJobSnapshot {
  status: string;
  final_status?: string | null;
  current_step?: string | null;
  sources_count?: number;
  partial_sources_count?: number;
  failed_sources_count?: number;
  error_stage?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  review?: Record<string, unknown> | null;
}

interface StreamJobSnapshot {
  status: string;
  finalStatus: string | null;
  currentStep: string | null;
  sourcesCount: number;
  partialSourcesCount: number;
  failedSourcesCount: number;
  errorStage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  review: Record<string, unknown> | null;
}

function toStreamSnapshot(value: UpstreamJobSnapshot): StreamJobSnapshot {
  return {
    status: value.status,
    finalStatus: value.final_status ?? null,
    currentStep: value.current_step ?? null,
    sourcesCount: value.sources_count ?? 0,
    partialSourcesCount: value.partial_sources_count ?? 0,
    failedSourcesCount: value.failed_sources_count ?? 0,
    errorStage: value.error_stage ?? null,
    errorCode: value.error_code ?? null,
    errorMessage: value.error_message ?? null,
    review: value.review ?? null,
  };
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export const GET = apiHandler<[NextRequest, { params: Promise<{ jobId: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;

  const parsed = IdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'jobId 必须为 UUID',
      requestId,
    });
  }

  // Keep the same ownership boundary as the regular status endpoint.
  const { prisma } = await import('../../../../../lib/db');
  const job = await prisma.aiResearchJob.findUnique({
    where: { id: parsed.data.jobId },
    select: { requesterId: true },
  });
  if (!job || job.requesterId !== user.id) {
    return toApiErrorResponse({
      code: ERROR_CODES.AI_JOB_NOT_FOUND,
      message: '任务不存在',
      requestId,
    });
  }

  const upstreamUrl = `${getWebEnv().AI_ENGINE_URL.replace(/\/$/u, '')}/api/ai/jobs/${parsed.data.jobId}`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        while (!req.signal.aborted) {
          const fetched = await fetchAiEngine<UpstreamJobSnapshot>({
            url: upstreamUrl,
            requestId,
            context: 'ai.bff.progress_stream',
            retry: false,
          });
          if (!fetched.ok) {
            send('error', { code: fetched.code, message: fetched.message });
            break;
          }

          const snapshot = toStreamSnapshot(fetched.body);
          send('progress', snapshot);
          if (TERMINAL.has(snapshot.finalStatus ?? snapshot.status)) break;
          await waitFor(1_000, req.signal);
        }
      } catch (error) {
        send('error', { code: ERROR_CODES.AI_ENGINE_UNAVAILABLE, message: String(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': requestId,
    },
  });
});
