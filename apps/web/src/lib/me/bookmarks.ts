import { prisma } from '@/lib/db';

export interface BookmarkRecord {
  id: string;
  targetType: string;
  targetId: string;
  note: string | null;
  createdAt: Date;
}

export interface BookmarkView {
  id: string;
  targetType: string;
  targetLabel: string;
  targetId: string;
  title: string;
  href: string | null;
  available: boolean;
  note: string | null;
  createdAt: string;
}

const TARGET_LABELS: Record<string, string> = {
  radar_candidate: '雷达',
  summary: '摘要',
  research: '调研',
  knowledge: '精华',
  daily_digest: '雷达日报',
};

export async function hydrateBookmarks(items: BookmarkRecord[]): Promise<BookmarkView[]> {
  const summaryIds = items
    .filter((item) => ['radar_candidate', 'summary', 'daily_digest'].includes(item.targetType))
    .map((item) => item.targetId);
  const researchIds = items
    .filter((item) => ['research', 'knowledge'].includes(item.targetType))
    .map((item) => item.targetId);

  const [summaries, researches] = await Promise.all([
    summaryIds.length > 0
      ? prisma.summary.findMany({
          where: { id: { in: summaryIds } },
          select: { id: true, title: true },
        })
      : [],
    researchIds.length > 0
      ? prisma.research.findMany({
          where: { id: { in: researchIds } },
          select: { id: true, title: true },
        })
      : [],
  ]);
  const summaryTitles = new Map(summaries.map((item) => [item.id, item.title]));
  const researchTitles = new Map(researches.map((item) => [item.id, item.title]));

  return items.map((item) => {
    const isSummary = ['radar_candidate', 'summary', 'daily_digest'].includes(item.targetType);
    const title = (isSummary ? summaryTitles : researchTitles).get(item.targetId);
    const href = title
      ? item.targetType === 'radar_candidate' || item.targetType === 'daily_digest'
        ? `/radar/${item.targetId}`
        : item.targetType === 'summary'
          ? `/summaries/${item.targetId}`
          : `/researches/${item.targetId}`
      : null;
    return {
      id: item.id,
      targetType: item.targetType,
      targetLabel: TARGET_LABELS[item.targetType] ?? '内容',
      targetId: item.targetId,
      title: title || '内容已不存在',
      href,
      available: Boolean(title),
      note: item.note,
      createdAt: item.createdAt.toISOString(),
    };
  });
}
