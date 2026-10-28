// BFF handler: POST /api/researches/[id]/review — queue a review run for
// the current draft snapshot.
//
// A review is intentionally asynchronous.  The user should be able to keep
// reading while the worker builds a claim/evidence ledger, and a reviewer
// outage must not turn into a synchronous request failure.  Each invocation
// creates a durable run; legacy review* fields are updated as compatibility
// mirrors only.

import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { apiHandler } from '../../../../../lib/api-handler';
import { requireUser } from '../../../../../lib/auth/session';
import { prisma } from '../../../../../lib/db';
import { toApiErrorResponse } from '../../../../../lib/errors';
import { withRequestId } from '../../../../../lib/log';
import { ERROR_CODES } from '@deep-research/shared/errors';
import { hashResearchRevision } from '../../../../../lib/research-revision';
import { hashCanonicalSourceSnapshot } from '../../../../../lib/research-source-snapshot';
import { evaluateResearchSufficiency } from '../../../../../lib/research-sufficiency';
import { ResearchBriefSchema } from '@deep-research/shared/schemas';

const IdParam = z.object({ id: z.string().uuid() });

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(async (req, ctx) => {
  const requestId = withRequestId(req.headers);
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  const parsed = IdParam.safeParse(await ctx.params);
  if (!parsed.success) {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'id 必须为 UUID',
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const research = await prisma.research.findUnique({
    where: { id: parsed.data.id },
    select: {
      id: true,
      authorId: true,
      status: true,
      creationMethod: true,
      title: true,
      body: true,
      background: true,
      conclusion: true,
      risks: true,
      tags: true,
      reviewStatus: true,
      sourceAiJob: {
        select: {
          id: true,
          brief: true,
          sourcePolicy: true,
          partialSources: true,
          aiResearchSources: {
            orderBy: { createdAt: 'asc' },
            select: { canonicalKey: true, title: true, snippet: true },
          },
        },
      },
      researchSources: {
        orderBy: { createdAt: 'asc' },
        select: { sourceRef: true, canonicalKey: true, title: true, description: true },
      },
    },
  });
  if (
    !research
    || (research.authorId !== user.id && user.role !== 'admin')
    || research.status !== 'draft'
  ) {
    return toApiErrorResponse({
      code: ERROR_CODES.DRAFT_NOT_FOUND,
      message: '草稿不存在',
      requestId,
    });
  }
  if (research.creationMethod !== 'ai_research') {
    return toApiErrorResponse({
      code: ERROR_CODES.VALIDATION_FAILED,
      message: '只有 AI 调研草稿需要事实审核',
      requestId,
    });
  }
  const revisionHash = hashResearchRevision(research);
  const fullSnapshot = matchingCapturedSnapshot(research.researchSources, research.sourceAiJob?.partialSources);
  const sourceSnapshotHash = fullSnapshot ? hashText(stableJson(fullSnapshot)) : hashCanonicalSourceSnapshot(research.researchSources);
  const runId = randomUUID();
  const queuedAt = new Date();
  const parsedBrief = ResearchBriefSchema.safeParse(research.sourceAiJob?.brief);
  const researchSufficiency = evaluateResearchSufficiency({
    brief: parsedBrief.success ? parsedBrief.data : null,
    sources: research.sourceAiJob?.aiResearchSources ?? [],
    reportContent: research.body,
    sourcePolicy: research.sourceAiJob?.sourcePolicy
      ?? (parsedBrief.success ? parsedBrief.data.sourcePolicy : null),
  });
  const queuedDetails = {
    phase: 'queued',
    sourceSnapshotFormat: 'canonical-v1',
    status: 'queued',
    attempts: 0,
    runId,
    revisionHash,
    sourceSnapshotHash,
    triggeredBy: 'manual',
    researchSufficiency: researchSufficiency as unknown as Prisma.InputJsonValue,
    queuedAt: queuedAt.toISOString(),
  };

  try {
    await prisma.$transaction(async (tx) => {
      const running = await tx.researchReviewRun.findFirst({
        where: {
          researchId: research.id,
          executionStatus: { in: ['queued', 'reviewing'] },
        },
        select: {
          id: true,
          executionStatus: true,
          startedAt: true,
          leaseExpiresAt: true,
          details: true,
        },
      });
      if (running) {
        // A reviewer owns a run only while its lease is alive. Treat an
        // abandoned reviewing run as an operational failure and close it in
        // the same transaction that queues the replacement. Otherwise a
        // crashed worker leaves the draft permanently stuck at "reviewing"
        // and the user cannot recover without an admin touching the DB.
        const now = queuedAt.getTime();
        const leaseExpired = running.executionStatus === 'reviewing'
          && (
            (running.leaseExpiresAt && running.leaseExpiresAt.getTime() <= now)
            || (
              !running.leaseExpiresAt
              && running.startedAt
              && running.startedAt.getTime() <= now - 10 * 60 * 1000
            )
          );
        if (!leaseExpired) throw new Error('REVIEW_ALREADY_RUNNING');

        const previousDetails = running.details && typeof running.details === 'object' && !Array.isArray(running.details)
          ? running.details as Record<string, unknown>
          : {};
        await tx.researchReviewRun.update({
          where: { id: running.id },
          data: {
            executionStatus: 'unavailable',
            outcome: 'unavailable',
            completedAt: queuedAt,
            leaseExpiresAt: null,
            heartbeatAt: null,
            details: {
              ...previousDetails,
              phase: 'completed',
              status: 'review_unavailable',
              error_code: 'reviewer_lease_expired',
              recoveredAt: queuedAt.toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
      }

      await tx.researchReviewRun.create({
        data: {
          id: runId,
          researchId: research.id,
          aiResearchJobId: research.sourceAiJob?.id ?? null,
          revisionHash,
          sourceSnapshotHash,
          policyVersion: 'fact-review-v1',
          executionStatus: 'queued',
          outcome: null,
          attempt: 0,
          details: queuedDetails as Prisma.InputJsonValue,
          triggeredBy: 'manual',
          createdAt: queuedAt,
        },
      });

      if (research.sourceAiJob?.id) {
        await tx.aiResearchJob.update({
          where: { id: research.sourceAiJob.id },
          data: {
            reviewStatus: 'queued',
            reviewAttempts: 0,
            reviewStartedAt: null,
            reviewRunToken: null,
            reviewSummary: Prisma.DbNull,
            reviewClaims: [],
            reviewedAt: null,
            reviewDetails: queuedDetails as Prisma.InputJsonValue,
          },
        });
      }
      // The publish transaction uses the same draft predicate.  This final
      // compare-and-set closes the queue-vs-publish race: whichever action
      // acquires the draft row first wins, while the losing transaction is
      // rolled back instead of leaving an active run attached to a published
      // row (or publishing a snapshot that just entered review).
      const draftUpdated = await tx.research.updateMany({
        where: { id: research.id, status: 'draft' },
        data: {
          reviewStatus: 'queued',
          reviewAttempts: 0,
          reviewStartedAt: null,
          reviewRunToken: null,
          reviewSummary: Prisma.DbNull,
          reviewClaims: [],
          reviewedAt: null,
          reviewDetails: queuedDetails as Prisma.InputJsonValue,
        },
      });
      if (draftUpdated.count !== 1) throw new Error('REVIEW_DRAFT_CHANGED');
    });
  } catch (error) {
    if (
      error instanceof Error
      && (error.message === 'REVIEW_ALREADY_RUNNING' || error.message === 'REVIEW_DRAFT_CHANGED')
    ) {
      return NextResponse.json(
        { code: ERROR_CODES.AI_REVIEW_CONFLICT, message: '这份草稿正在审核，请等待当前审核结束。', requestId },
        { status: 409 },
      );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json(
        { code: ERROR_CODES.AI_REVIEW_CONFLICT, message: '这份草稿正在审核，请等待当前审核结束。', requestId },
        { status: 409 },
      );
    }
    throw error;
  }

  return NextResponse.json({
    status: 'queued',
    attempts: 0,
    run: {
      id: runId,
      executionStatus: 'queued',
      outcome: null,
      revisionHash,
      sourceSnapshotHash,
      policyVersion: 'fact-review-v1',
      attempt: 0,
      triggeredBy: 'manual',
      createdAt: queuedAt.toISOString(),
    },
    review: queuedDetails,
  }, { status: 202 });
});

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}




type PreviewSource = { sourceRef: unknown; canonicalKey: string; title: string | null; description: string | null };
type CapturedSource = { canonicalKey: string; sourceRef: Record<string, string | boolean>; title: string | null; snippet: string | null };
function codepointCompare(a: string, b: string): number {
  const aa = Array.from(a, (x) => x.codePointAt(0)!); const bb = Array.from(b, (x) => x.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  return aa.length - bb.length;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => codepointCompare(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function clip(value: string | null, limit: number): string | null {
  if (value === null || Array.from(value).length <= limit) return value;
  return `${Array.from(value).slice(0, limit - 1).join('').trimEnd()}…`;
}
function matchingCapturedSnapshot(preview: PreviewSource[], partial: unknown): CapturedSource[] | null {
  if (!Array.isArray(partial) || !partial.length || !preview.length) return null;
  const captured = new Map<string, CapturedSource>();
  const duplicates = new Set<string>();
  for (const item of partial) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const key = row.canonical_key ?? row.canonicalKey; const ref = row.source_ref ?? row.sourceRef;
    if (typeof key !== 'string' || !ref || typeof ref !== 'object' || Array.isArray(ref) ||
        !Object.keys(ref).length || Object.values(ref).some((v) => typeof v !== 'string' && typeof v !== 'boolean') ||
        !(row.title === null || typeof row.title === 'string') || typeof row.snippet !== 'string' || !row.snippet.trim()) continue;
    if (captured.has(key)) { captured.delete(key); duplicates.add(key); continue; }
    if (!duplicates.has(key)) captured.set(key, { canonicalKey: key, sourceRef: ref as Record<string, string | boolean>, title: row.title, snippet: row.snippet });
  }
  let upgraded = false;
  const combined: CapturedSource[] = [];
  for (const source of preview) {
    if (!source.sourceRef || typeof source.sourceRef !== 'object' || Array.isArray(source.sourceRef) ||
        !Object.keys(source.sourceRef).length || Object.values(source.sourceRef).some((v) => typeof v !== 'string' && typeof v !== 'boolean')) return null;
    const saved = captured.get(source.canonicalKey);
    const match = saved && stableJson(source.sourceRef) === stableJson(saved.sourceRef) &&
      source.title === clip(saved.title, 300) && source.description === clip(saved.snippet, 1000);
    if (match) upgraded = true;
    combined.push({ canonicalKey: source.canonicalKey, sourceRef: source.sourceRef as Record<string, string | boolean>,
      title: source.title, snippet: match ? saved.snippet : source.description });
  }
  return upgraded ? combined.sort((a, b) => codepointCompare(a.canonicalKey, b.canonicalKey)) : null;
}
