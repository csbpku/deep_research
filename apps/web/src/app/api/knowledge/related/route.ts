import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { knowledgePageUrl, readingRadarOrigin } from '@/lib/knowledge-provenance';
import { toApiErrorResponse } from '@/lib/errors';
import { withRequestId } from '@/lib/log';

const Query = z.object({ radarSummaryId: z.string().uuid().optional(), topicId: z.string().uuid().optional() })
  .refine(value => Boolean(value.radarSummaryId || value.topicId));

export const GET = apiHandler<[NextRequest]>(async req => {
  const user = await requireUser(req);
  if (user instanceof Response) return user;
  const params = new URL(req.url).searchParams;
  const parsed = Query.safeParse({
    radarSummaryId: params.get('radarSummaryId') ?? undefined, topicId: params.get('topicId') ?? undefined,
  });
  if (!parsed.success) return toApiErrorResponse({
    code: 'VALIDATION_FAILED', message: '请提供有效的雷达或专题', requestId: withRequestId(req.headers),
  });
  const { radarSummaryId, topicId } = parsed.data;
  const radar = radarSummaryId ? await readingRadarOrigin(radarSummaryId) : null;
  if (radarSummaryId && !radar) return NextResponse.json({ items: [] });
  const topics = radar ? await prisma.topicCandidate.findMany({
    where: { summaryId: radar.id, topic: { enabled: true } }, select: { topicId: true }, take: 20,
  }) : [];
  const topicIds = [...new Set([...topics.map(row => row.topicId), ...(topicId ? [topicId] : [])])];
  const select = {
      id: true, title: true, conclusion: true, knowledgeIndexText: true, status: true, updatedAt: true,
      researchSources: { select: { sourceRef: true, canonicalKey: true }, take: 20 },
  } as const;
  const personal = {
    authorId: user.id, status: { in: ['draft' as const, 'published' as const] },
    OR: [{ type: 'knowledge' as const, knowledgeIndexText: { not: null } }, { type: 'research' as const, conclusion: { not: null } }],
  };
  const sourcePage = radar ? new URL(radar.url) : null;
  const [exactRows, sourceRows, topicRows] = await Promise.all([
    radar ? prisma.research.findMany({
      where: { ...personal, AND: [{ OR: [
        { researchSources: { some: { sourceRef: { path: ['radarSummaryId'], equals: radar.id } } } },
        { researchSources: { some: { canonicalKey: { in: [radar.url, knowledgePageUrl(radar.url)!] } } } },
      ] }] },
      select, orderBy: { updatedAt: 'desc' }, take: 3,
    }) : [],
    radar && sourcePage ? prisma.research.findMany({
      where: { ...personal, AND: [{ OR: [
        { researchSources: { some: { sourceRef: { path: ['radarSummaryId'], equals: radar.id } } } },
        { researchSources: { some: { canonicalKey: { startsWith: `${sourcePage.origin}${sourcePage.pathname}` } } } },
      ] }] },
      select, orderBy: { updatedAt: 'desc' }, take: 60,
    }) : [],
    topicIds.length ? prisma.research.findMany({
      where: { ...personal, researchTopics: { some: { topicId: { in: topicIds }, topic: { enabled: true } } } },
      select, orderBy: { updatedAt: 'desc' }, take: 6,
    }) : [],
  ]);
  const direct = (row: typeof sourceRows[number]) => Boolean(radar && row.researchSources.some(source => {
    const ref = source.sourceRef;
    return ref && typeof ref === 'object' && !Array.isArray(ref) && ref.radarSummaryId === radar.id
      || typeof source.canonicalKey === 'string' && knowledgePageUrl(source.canonicalKey) === knowledgePageUrl(radar.url);
  }));
  const rows = [...new Map([...exactRows, ...sourceRows.filter(direct), ...topicRows].map(row => [row.id, row])).values()];
  const items = rows.sort((a, b) => Number(direct(b)) - Number(direct(a))).slice(0, 3).map(row => ({
    id: row.id, title: row.title, conclusion: (row.conclusion || row.knowledgeIndexText || '').slice(0, 500),
    status: row.status, private: row.status !== 'published', updatedAt: row.updatedAt.toISOString(),
    matchReason: direct(row) ? '同一来源' : '同一专题',
  }));
  return NextResponse.json({ items }, { headers: { 'cache-control': 'private, no-store' } });
});
