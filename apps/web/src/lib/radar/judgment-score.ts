// 雷达判断（read / later / pilot / inaccurate）的排序信号。
//
// 判断是群体信号而不是个性化 feed：所有人看到同一顺序，分页不需要额外
// join，也不会因为“本人没点过”而让同一页在不同用户间抖动。代价是无法
// 表达个人偏好——这是 P0-4 明确接受的取舍。
//
// 分值维护在 summaries.judgmentScore 上，由 /api/radar-feedback 在写反馈
// 的同一事务里重算。distilledTotal 仍是第一排序键，判断只用于质量同分的
// 条目之间再平衡：它可以让 88 分的“试点”排在 88 分的“不感兴趣”之前，
// 但不能把 70 分抬到 90 分之上。

import type { Prisma } from '@prisma/client';
import { RADAR_JUDGMENT_FEEDBACK_TYPES } from '@deep-research/shared/states';

export type RadarJudgmentType = (typeof RADAR_JUDGMENT_FEEDBACK_TYPES)[number];

/**
 * 四个判断的权重。read 取轻微负值而不是 0，是为了让“已经读过”在同分时
 * 给新内容/可行动内容让位；inaccurate 更负，因为它同时是“不感兴趣”的
 * 落点。useful / used / favorite / suggest_research 不计入：favorite 与
 * useful 常常同时出现，计入会重复加权，也会让收藏变成排序武器；而且
 * favorite 还会被 /api/me/bookmarks 直接写入，排除它才能让本文件保持
 * “判断分只有 /api/radar-feedback 一个写入口”的边界。
 *
 * 若未来调整权重，除了改这里，还需要一个迁移/一次性重算，因为
 * summaries.judgmentScore 是物化值，不会自动回溯。
 */
export const RADAR_JUDGMENT_SCORE_WEIGHTS = {
  pilot: 2,
  later: 1,
  read: -1,
  inaccurate: -2,
} as const satisfies Record<RadarJudgmentType, number>;

/**
 * 单个条目的群体分上限。±20 约等于 10 个 pilot / 10 个 inaccurate，远高于
 * 内部正常使用量，同时避免刷票把一条内容无限抬升或埋葬。真实使用时几乎
 * 不会触顶；触顶只是安全阀，不是产品语义。
 */
export const RADAR_JUDGMENT_SCORE_BOUND = 20;

/**
 * 列表排序契约：质量分优先，判断分只在同分时生效，最后用 createdAt/id
 * 保证分页稳定。id 必须是最后一个 tie-breaker，且方向固定为 asc。
 */
export const RADAR_LIST_ORDER_BY = [
  { distilledTotal: { sort: 'desc', nulls: 'last' } },
  { judgmentScore: 'desc' },
  { createdAt: 'desc' },
  { id: 'asc' },
] as const satisfies readonly Prisma.SummaryOrderByWithRelationInput[];

export type RadarFeedbackCounts = Partial<Record<RadarJudgmentType, number>>;

/** groupBy 的返回形状；用最小结构便于单测不依赖 Prisma 运行时。 */
export type RadarJudgmentGroup = {
  feedbackType: string;
  _count: { feedbackType: number };
};

export function isRadarJudgmentType(value: string): value is RadarJudgmentType {
  return Object.prototype.hasOwnProperty.call(RADAR_JUDGMENT_SCORE_WEIGHTS, value);
}

/**
 * 把判断计数折算成有界分值。未知类型（useful/favorite 等）直接忽略；
 * 空计数返回 0，因此没有反馈的历史行与“判断被全部撤销”的行都落到 0。
 */
export function computeRadarJudgmentScore(counts: RadarFeedbackCounts): number {
  let raw = 0;
  for (const [type, weight] of Object.entries(RADAR_JUDGMENT_SCORE_WEIGHTS) as Array<
    [RadarJudgmentType, number]
  >) {
    raw += (counts[type] ?? 0) * weight;
  }
  return Math.max(-RADAR_JUDGMENT_SCORE_BOUND, Math.min(RADAR_JUDGMENT_SCORE_BOUND, raw));
}

export function computeRadarJudgmentScoreFromGroups(
  groups: readonly RadarJudgmentGroup[],
): number {
  const counts: RadarFeedbackCounts = {};
  for (const group of groups) {
    if (isRadarJudgmentType(group.feedbackType)) {
      counts[group.feedbackType] = group._count.feedbackType;
    }
  }
  return computeRadarJudgmentScore(counts);
}

/**
 * 同一 summary 的聚合重算必须串行，否则两个并发请求会各自 groupBy 到
 * 对方的“旧”快照，后写者覆盖先写者（lost update）。用事务级 advisory
 * lock：随 commit/rollback 自动释放，不需要额外清理，也不会锁表。
 */
export async function lockJudgmentAggregate(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  summaryId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${summaryId}))`;
}

/**
 * 重算并写回单个 summary 的群体判断分，返回写入值。
 *
 * 使用 updateMany 而不是 update：summary 若在事务期间被删除，这里应当
 * 是 no-op（反馈行也会被级联删除），而不是用 P2025 让整个请求失败。
 */
export async function recomputeSummaryJudgmentScore(
  db: Pick<Prisma.TransactionClient, 'radarFeedback' | 'summary'>,
  summaryId: string,
): Promise<number> {
  const groups = await db.radarFeedback.groupBy({
    by: ['feedbackType'],
    where: { summaryId },
    _count: { feedbackType: true },
  });
  const score = computeRadarJudgmentScoreFromGroups(groups);
  await db.summary.updateMany({
    where: { id: summaryId },
    data: { judgmentScore: score },
  });
  return score;
}
