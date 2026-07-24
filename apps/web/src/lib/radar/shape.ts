// 雷达共享 helper —— 把 summary 行为规整到 列表 / 详情 响应。
//
// 雷达候选实际存储在 summaries 表（source='daily' 且 syncRunId 非空）。
// 这里的 helper 负责：
//   1. 从 Prisma 行抽取雷达字段
//   2. 规范化日期格式
//   3. 组装候选 + 当前用户反馈 + 计数

import type { RadarFeedbackType } from '@deep-research/shared/states';

export type RadarFeedbackCount = {
  useful: number;
  inaccurate: number;
  used: number;
  favorite: number;
  suggest_research: number;
};

export const RADAR_FEEDBACK_TYPES = [
  'useful',
  'inaccurate',
  'used',
  'favorite',
  'suggest_research',
] as const satisfies readonly RadarFeedbackType[];

export type RadarCandidateShape = {
  id: string;
  title: string;
  excerpt: string;
  body: string | null;
  url: string;
  sourceType: string | null;
  syncRunId: string | null;
  syncDate: string | null;
  tags: string[];
  status: string;
  publishedAt: string | null;
  crawledAt: string;
  interpretation: string | null;
  scoreReason: string | null;
  scoreVersion: string | null;
  relevanceScore: number | null;
  timelinessScore: number | null;
  sourceQualityScore: number | null;
  summaryDate: string;
  selectionReason: string | null;
  sortOrder: number | null;
  sharedBy: { id: string; name: string } | null;
  feedbackCounts: RadarFeedbackCount;
  myFeedbacks: RadarFeedbackType[];
};

/** 列表默认反馈计数（避免每个候选都 groupBy 一次）。 */
export function emptyFeedbackCounts(): RadarFeedbackCount {
  return { useful: 0, inaccurate: 0, used: 0, favorite: 0, suggest_research: 0 };
}

/** 从 raw prisma 行做类型对齐；返回可序列化对象。 */
export function shapeCandidate(input: {
  summary: {
    id: string;
    title: string;
    body: string;
    url: string;
    tags: string[];
    status: string;
    summaryDate: Date;
    publishedAt: Date | null;
    createdAt: Date;
    interpretation: string | null;
    scoreReason: string | null;
    scoreVersion: string | null;
    relevanceScore: number | null;
    timelinessScore: number | null;
    sourceQualityScore: number | null;
    selectionReason: string | null;
    sortOrder: number | null;
    syncRunId: string | null;
    sharedBy?: { id: string; name: string } | null;
    syncRun?: {
      id: string;
      completedAt: Date | null;
      source: { sourceType: string; name: string } | null;
    } | null;
  };
  feedbackCounts?: RadarFeedbackCount;
  myFeedbacks?: RadarFeedbackType[];
  includeBody?: boolean;
}): RadarCandidateShape {
  const s = input.summary;
  const counts = input.feedbackCounts ?? emptyFeedbackCounts();
  const mine = input.myFeedbacks ?? [];
  return {
    id: s.id,
    title: s.title,
    excerpt: excerptOf(s.body, 280),
    body: input.includeBody === false ? null : s.body,
    url: s.url,
    sourceType: s.syncRun?.source?.sourceType ?? null,
    syncRunId: s.syncRunId,
    syncDate: s.syncRun?.completedAt
      ? s.syncRun.completedAt.toISOString()
      : null,
    tags: s.tags,
    status: s.status,
    publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
    crawledAt: s.createdAt.toISOString(),
    interpretation: s.interpretation,
    scoreReason: s.scoreReason,
    scoreVersion: s.scoreVersion,
    relevanceScore: s.relevanceScore,
    timelinessScore: s.timelinessScore,
    sourceQualityScore: s.sourceQualityScore,
    summaryDate: s.summaryDate.toISOString().slice(0, 10),
    selectionReason: s.selectionReason,
    sortOrder: s.sortOrder,
    sharedBy: s.sharedBy ?? null,
    feedbackCounts: counts,
    myFeedbacks: mine,
  };
}

/** 取前 N 个字符；保留换行前的整段语义边界（句号/问号/感叹号/换行）。 */
export function excerptOf(body: string, max: number): string {
  if (body.length <= max) return body;
  const contentLimit = Math.max(0, max - 1);
  const sliced = body.slice(0, contentLimit);
  const boundary = Math.max(
    sliced.lastIndexOf('.'),
    sliced.lastIndexOf('!'),
    sliced.lastIndexOf('?'),
    sliced.lastIndexOf('\n'),
  );
  if (boundary >= contentLimit / 3) {
    return sliced.slice(0, boundary + 1);
  }
  return sliced + '…';
}

/** 把 YYYY-MM-DD 字符串（UTC 当日 00:00:00）解析成 Date 对象。 */
export function parseUtcDate(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split('-').map((s) => Number(s));
  return new Date(Date.UTC(y, m - 1, d));
}

/** 把 Date 转 YYYY-MM-DD（UTC）。 */
export function isoDateOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 取一组 summaryId 的反馈：counts（按 type 分组）+ myFeedbacks（当前用户）。
 * 用单次 groupBy 拿 counts；再单次 where 拿 myFeedbacks。
 *
 * 类型策略：直接接受 PrismaClient（不展开 groupBy 复杂泛型），但保持调用方
 * 类型安全。
 */
export async function aggregateFeedbacks(
  prisma: any,
  summaryIds: string[],
  userId: string,
): Promise<Map<string, { counts: RadarFeedbackCount; mine: RadarFeedbackType[] }>> {
  const result = new Map<string, { counts: RadarFeedbackCount; mine: RadarFeedbackType[] }>();
  for (const id of summaryIds) {
    result.set(id, { counts: emptyFeedbackCounts(), mine: [] });
  }
  if (summaryIds.length === 0) return result;

  const grouped: Array<{ summaryId: string; feedbackType: string; _count: { feedbackType: number } }> =
    await prisma.radarFeedback.groupBy({
      by: ['summaryId', 'feedbackType'],
      where: { summaryId: { in: summaryIds } },
      _count: { feedbackType: true },
    });
  for (const row of grouped) {
    const entry = result.get(row.summaryId);
    if (!entry) continue;
    const ft = row.feedbackType as keyof RadarFeedbackCount;
    if (ft in entry.counts) {
      entry.counts[ft] = row._count.feedbackType;
    }
  }

  const mine: Array<{ summaryId: string; feedbackType: string }> =
    await prisma.radarFeedback.findMany({
      where: { summaryId: { in: summaryIds }, userId },
      select: { summaryId: true, feedbackType: true },
    });
  for (const row of mine) {
    const entry = result.get(row.summaryId);
    if (!entry) continue;
    entry.mine.push(row.feedbackType as RadarFeedbackType);
  }

  return result;
}

/** 简单标签归一化（lowercase + trim + 去空）；不修改输入数组。 */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const trimmed = t.trim().toLowerCase();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * 过滤 query 是否匹配候选的 title / interpretation / tags。
 * 简单大小写不敏感 substring；不在 DB 做全文检索（W5 不开 search_docs 路径）。
 */
export function matchesQuery(input: {
  query: string | undefined;
  title: string;
  interpretation: string | null;
  tags: string[];
}): boolean {
  if (!input.query || input.query.length === 0) return true;
  const q = input.query.toLowerCase();
  if (input.title.toLowerCase().includes(q)) return true;
  if (input.interpretation && input.interpretation.toLowerCase().includes(q)) return true;
  return input.tags.some((t) => t.toLowerCase().includes(q));
}
