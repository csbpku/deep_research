// Admin 将被过滤候选提升为普通雷达候选。

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { apiHandler } from '@/lib/api-handler';
import { requireAdmin } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { toApiErrorResponse } from '@/lib/errors';
import { log, withRequestId } from '@/lib/log';
import {
  ADMIN_RADAR_ACTIONS,
  ADMIN_TARGET_TYPE,
  newAdminActionRequestId,
  writeAdminAction,
} from '@/lib/radar/admin-actions';
import { forwardAdminRadarAction } from '@/lib/admin-radar-action';
import { ERROR_CODES } from '@deep-research/shared/errors';

export const POST = apiHandler<[NextRequest, { params: Promise<{ id: string }> }]>(
  async (req, ctx) => {
    const requestId = withRequestId(req.headers);
    const admin = await requireAdmin(req);
    if (admin instanceof NextResponse) return admin;
    const id = (await ctx.params).id;

    const actionRequestId = newAdminActionRequestId();
    try {
      const result = await prisma.$transaction(async (tx) => {
        const diagnostic = await tx.radarSyncDiagnostic.findUnique({ where: { id } });
        if (!diagnostic || diagnostic.kind !== 'filtered' || diagnostic.status !== 'pending') {
          throw new Error('DIAGNOSTIC_NOT_PROMOTABLE');
        }

        const existing = await tx.summary.findUnique({
          where: { canonicalUrl: diagnostic.canonicalUrl },
          select: { id: true, tags: true },
        });
        let summaryId = existing?.id;
        if (existing) {
          await tx.summary.update({
            where: { id: existing.id },
            data: {
              status: 'candidate',
              tags: [...new Set([...existing.tags, 'admin_promoted'])],
            },
          });
        }
        if (!summaryId) {
          const score = (diagnostic.distilledScore ?? {}) as Record<string, unknown>;
          const total = typeof score.rankingScore === 'number'
            ? score.rankingScore
            : typeof score.effectiveTotal === 'number'
              ? score.effectiveTotal
              : typeof score.total === 'number'
                ? score.total
                : null;
          const origin = diagnostic.contentOrigin === 'rss'
            ? 'rss'
            : diagnostic.contentOrigin === 'web'
              ? 'web'
              : 'api';
          const created = await tx.summary.create({
            data: {
              title: diagnostic.title,
              body: diagnostic.body || diagnostic.title,
              url: diagnostic.url,
              canonicalUrl: diagnostic.canonicalUrl,
              source: 'daily',
              contentOrigin: origin,
              summaryDate: diagnostic.publishedAt ?? diagnostic.createdAt,
              publishedAt: diagnostic.publishedAt,
              tags: [...new Set([...diagnostic.tags, 'admin_promoted'])],
              status: 'candidate',
              distilledScore: diagnostic.distilledScore ?? undefined,
              distilledTotal: total,
              distilledTier: diagnostic.distilledTier,
              distilledMustRead: Boolean(score.mustRead),
              syncRunId: diagnostic.runId,
              interpretation: (diagnostic.body || '').slice(0, 2000) || null,
              selectionReason: 'Admin 从同步过滤队列人工提升',
              originalMarkdown: diagnostic.originalMarkdown,
              originalKind: diagnostic.originalKind,
              originalFetchedAt: diagnostic.createdAt,
              originalBytes: diagnostic.originalMarkdown?.length ?? null,
            },
            select: { id: true },
          });
          summaryId = created.id;
        }

        const updated = await tx.radarSyncDiagnostic.update({
          where: { id: diagnostic.id },
          data: { status: 'promoted', promotedSummaryId: summaryId },
          select: { id: true, status: true, promotedSummaryId: true },
        });
        await writeAdminAction(tx, {
          actorId: admin.id,
          action: ADMIN_RADAR_ACTIONS.PROMOTE_DIAGNOSTIC,
          targetType: ADMIN_TARGET_TYPE.RADAR_DIAGNOSTIC,
          targetId: diagnostic.id,
          requestId: actionRequestId,
          metadata: { summaryId, runId: diagnostic.runId, reasonCode: diagnostic.reasonCode },
        });
        return updated;
      });

      log.info('admin.radar.promote_diagnostic', 'filtered radar candidate promoted', {
        requestId,
        diagnosticId: id,
        summaryId: result.promotedSummaryId,
      });
      let enrichmentQueued = false;
      if (result.promotedSummaryId) {
        try {
          const enrichmentResponse = await forwardAdminRadarAction(
            req,
            '/api/radar/enrich',
            { summaryIds: [result.promotedSummaryId], force: true },
          );
          enrichmentQueued = enrichmentResponse.ok;
          if (!enrichmentQueued) {
            log.warn('admin.radar.promote_enrichment_queue_failed', 'promote succeeded but enrichment queueing failed', {
              requestId,
              diagnosticId: id,
              summaryId: result.promotedSummaryId,
              status: enrichmentResponse.status,
            });
          }
        } catch (error) {
          log.warn('admin.radar.promote_enrichment_queue_error', 'promote succeeded but enrichment queueing errored', {
            requestId,
            diagnosticId: id,
            summaryId: result.promotedSummaryId,
            error: error instanceof Error ? error.message : 'unknown_error',
          });
        }
      }
      return NextResponse.json({ ok: true, diagnostic: result, enrichmentQueued, actionRequestId, requestId });
    } catch (error) {
      if (error instanceof Error && error.message === 'DIAGNOSTIC_NOT_PROMOTABLE') {
        return toApiErrorResponse({
          code: ERROR_CODES.VALIDATION_FAILED,
          message: '该过滤记录不存在、已处理或不可提升',
          requestId,
        });
      }
      throw error;
    }
  },
);
