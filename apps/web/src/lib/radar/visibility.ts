// 雷达候选可见性规则 —— /api/radar/[id]、transform、chat seedSummary 等共用。
//
// 规则与详情页一致：
//   - 仅自动雷达（daily + syncRunId）或已审核通过的用户分享；
//   - 非 admin：未评分 / noise / 无 tier 一律隐藏；
//   - 非 admin：自动雷达的高价值（collection/deep_read）需 enrichment、reader 质量、
//     内容审核全部通过（external_reading 除外）。

import { hasPublicRadarScore } from './score-validity';

export type RadarVisibilityInput = {
  source: string;
  syncRunId: string | null;
  shareSource?: { status: string } | null;
  distilledScore?: unknown;
  distilledTier?: string | null;
  tags?: string[] | null;
  enrichmentStatus?: string | null;
  readerQualityStatus?: string | null;
  contentReviewStatus?: string | null;
};

export const radarVisibilitySelect = {
  id: true,
  source: true,
  syncRunId: true,
  shareSource: { select: { status: true } },
  distilledScore: true,
  distilledTier: true,
  tags: true,
  enrichmentStatus: true,
  readerQualityStatus: true,
  contentReviewStatus: true,
} as const;

export function isRadarSource(summary: Pick<RadarVisibilityInput, 'source' | 'syncRunId' | 'shareSource'>): boolean {
  return (
    (summary.source === 'daily' && summary.syncRunId !== null)
    || (summary.source === 'user' && summary.shareSource?.status === 'approved')
  );
}

export function radarTier(summary: Pick<RadarVisibilityInput, 'distilledScore' | 'distilledTier'>): string | null {
  if (summary.distilledTier) return summary.distilledTier;
  const score = summary.distilledScore;
  if (score && typeof score === 'object' && !Array.isArray(score)) {
    const tier = (score as Record<string, unknown>).tier;
    if (typeof tier === 'string') return tier;
  }
  return null;
}

export function isRadarSummaryVisible(summary: RadarVisibilityInput, isAdmin: boolean): boolean {
  if (!isRadarSource(summary)) return false;
  if (isAdmin) return true;
  const automatic = summary.source === 'daily' && summary.syncRunId !== null;
  if (automatic && !hasPublicRadarScore(summary)) return false;
  const tier = radarTier(summary);
  if (tier === null || tier === 'noise') return false;
  const externalReading = Boolean(summary.tags?.includes('external_reading'));
  const highValue = automatic && tier !== 'skim';
  if (
    highValue
    && !externalReading
    && !(
      summary.enrichmentStatus === 'ready'
      && summary.readerQualityStatus === 'ready'
      && summary.contentReviewStatus === 'approved'
    )
  ) return false;
  return true;
}

/**
 * AI 对话 seed 的可见性：归档一律拒绝；雷达来源遵循与详情页完全相同的规则；
 * 非雷达来源仅允许已发布摘要。
 */
export function canSeedChatFromSummary(
  summary: RadarVisibilityInput & { status: string },
  isAdmin: boolean,
): boolean {
  if (summary.status === 'archived') return false;
  if (isRadarSource(summary)) return isRadarSummaryVisible(summary, isAdmin);
  return summary.status === 'published';
}
