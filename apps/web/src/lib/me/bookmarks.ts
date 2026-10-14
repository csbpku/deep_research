import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth/session';
import { canSeedChatFromSummary, radarVisibilitySelect } from '@/lib/radar/visibility';

export interface BookmarkViewer {
  id: string;
  role: 'member' | 'admin';
}

type SummaryTarget = Parameters<typeof canSeedChatFromSummary>[0] & { sharedByUserId?: string | null };

/** 摘要对该 viewer 是否可见：与详情页同规则；自己分享的（含待审核）也可见。 */
export function isSummaryVisibleTo(summary: SummaryTarget, viewer: BookmarkViewer): boolean {
  if (summary.sharedByUserId && summary.sharedByUserId === viewer.id && summary.status !== 'archived') return true;
  return canSeedChatFromSummary(summary, viewer.role === 'admin');
}

/** 调研对该 viewer 是否可见：published 全员；draft/archived 仅 owner 与 admin。 */
export function isResearchVisibleTo(
  research: { status: string; authorId: string },
  viewer: BookmarkViewer,
): boolean {
  return research.status === 'published' || research.authorId === viewer.id || viewer.role === 'admin';
}

const summaryVisibleSelect = { ...radarVisibilitySelect, status: true, sharedByUserId: true } as const;

/** 目标是否存在且对 viewer 可见（POST 与 hydrate 共用；调用方对 false 统一返回同一个 404）。 */
export async function isBookmarkTargetVisible(
  targetType: string,
  targetId: string,
  viewer: BookmarkViewer,
): Promise<boolean> {
  if (targetType === 'radar_candidate' || targetType === 'summary') {
    const summary = await prisma.summary.findUnique({ where: { id: targetId }, select: summaryVisibleSelect });
    if (!summary) return false;
    if (targetType === 'radar_candidate' && !(summary.source === 'daily' && summary.syncRunId !== null)) return false;
    return isSummaryVisibleTo(summary, viewer);
  }
  const research = await prisma.research.findUnique({
    where: { id: targetId },
    select: { status: true, authorId: true },
  });
  return Boolean(research && isResearchVisibleTo(research, viewer));
}

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
};

export async function hydrateBookmarks(
  items: BookmarkRecord[],
  viewerArg?: BookmarkViewer,
): Promise<BookmarkView[]> {
  const viewer: BookmarkViewer | null = viewerArg ?? (await getCurrentUser());
  const summaryIds = items
    .filter((item) => ['radar_candidate', 'summary'].includes(item.targetType))
    .map((item) => item.targetId);
  const researchIds = items
    .filter((item) => ['research', 'knowledge'].includes(item.targetType))
    .map((item) => item.targetId);

  const [summaries, researches] = await Promise.all([
    summaryIds.length > 0
      ? prisma.summary.findMany({
          where: { id: { in: summaryIds } },
          select: { ...summaryVisibleSelect, title: true },
        })
      : [],
    researchIds.length > 0
      ? prisma.research.findMany({
          where: { id: { in: researchIds } },
          select: { id: true, title: true, status: true, authorId: true },
        })
      : [],
  ]);
  // 标题只对“当前可见”的目标返回；不可见与已删除一律表现为“内容已不存在”。
  const summaryTitles = new Map(
    summaries
      .filter((item) => viewer !== null && isSummaryVisibleTo(item, viewer))
      .map((item) => [item.id, item.title]),
  );
  const researchTitles = new Map(
    researches
      .filter((item) => viewer !== null && isResearchVisibleTo(item, viewer))
      .map((item) => [item.id, item.title]),
  );

  return items.map((item) => {
    const isSummary = ['radar_candidate', 'summary'].includes(item.targetType);
    const title = (isSummary ? summaryTitles : researchTitles).get(item.targetId);
    const href = title
      ? item.targetType === 'radar_candidate' || item.targetType === 'summary'
        ? `/radar/${item.targetId}`
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
