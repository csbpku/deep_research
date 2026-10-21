import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { hasPublicRadarScore } from './radar/score-validity';

/** Keep identity-bearing query parameters; discard only known reading/tracking hints. */
export function knowledgePageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/iu.test(key) || /^(?:fbclid|gclid|deep-research-(?:source|summary|platform|anchor))$/iu.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

export async function readingRadarOrigin(id: string, url?: string) {
  const radar = await prisma.summary.findUnique({
    where: { id },
    select: {
      id: true, url: true, title: true, status: true, source: true, syncRunId: true,
      distilledScore: true, distilledTier: true, tags: true,
      shareSource: { select: { status: true } },
    },
  });
  if (!radar || !knowledgePageUrl(radar.url) || !['candidate', 'published'].includes(radar.status)
    || !(radar.source === 'daily' && radar.syncRunId || radar.source === 'user' && radar.shareSource?.status === 'approved')
    || radar.source === 'daily' && !hasPublicRadarScore(radar)
    || radar.distilledTier === 'noise'
    || url && knowledgePageUrl(url) !== knowledgePageUrl(radar.url)) return null;
  return radar;
}

export async function attachRadarTopics(tx: Prisma.TransactionClient, researchId: string, summaryId: string) {
  const topics = await tx.topicCandidate.findMany({
    where: { summaryId, topic: { enabled: true } }, select: { topicId: true }, take: 20,
  });
  for (const { topicId } of topics) {
    await tx.researchTopic.upsert({
      where: { researchId_topicId: { researchId, topicId } },
      create: { researchId, topicId, relationType: 'auto' }, update: {},
    });
  }
}

export function visibleTopicResearch(userId?: string): Prisma.ResearchWhereInput {
  return {
    OR: [
      { status: 'published' },
      ...(userId ? [{ authorId: userId, status: 'draft' as const, type: 'knowledge' as const, knowledgeIndexText: { not: null } }] : []),
    ],
  };
}

export async function previousReadingJudgments(userId: string, url: string) {
  const canonical = knowledgePageUrl(url);
  if (!canonical) return [];
  const page = new URL(canonical);
  const rows = await prisma.research.findMany({
    where: {
      authorId: userId, type: 'knowledge', status: { in: ['draft', 'published'] },
      knowledgeIndexText: { not: null },
      researchSources: { some: { canonicalKey: { startsWith: `${page.origin}${page.pathname}` } } },
    },
    orderBy: { updatedAt: 'desc' }, take: 60,
    select: {
      id: true, title: true, conclusion: true, knowledgeIndexText: true, status: true, updatedAt: true,
      researchSources: { select: { canonicalKey: true, sourceRef: true }, take: 20 },
    },
  });
  return rows.filter(row => row.researchSources.some(source => knowledgePageUrl(source.canonicalKey) === canonical))
    .slice(0, 3).map(row => {
      const source = row.researchSources.find(item => knowledgePageUrl(item.canonicalKey) === canonical)!;
      const ref = source.sourceRef && typeof source.sourceRef === 'object' && !Array.isArray(source.sourceRef)
        ? source.sourceRef as Record<string, unknown> : {};
      return {
        id: row.id, title: row.title, conclusion: (row.conclusion || row.knowledgeIndexText || '').slice(0, 600),
        status: row.status, updatedAt: row.updatedAt.toISOString(), url: source.canonicalKey,
        radarSummaryId: typeof ref.radarSummaryId === 'string' ? ref.radarSummaryId : null,
      };
    });
}
