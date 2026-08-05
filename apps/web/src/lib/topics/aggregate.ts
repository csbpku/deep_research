// P1-D: 主题聚合与 tier 计算的轻工具。
// 不引入 LLM / 嵌入；V1 仅做 tag 集合 + 候选数门槛判定。
// 真正的 LLM 综述由 ai-engine 的 topic_synthesis worker 写 synthesisPayload。

import type { TopicTier } from '@prisma/client';

export const TOPIC_THRESHOLDS = {
  windowDays: 14,
  recentDays: 7,
  minCandidates: 3,
  minSources: 2,
} as const;

/** 给定最近 7 天 vs 前 7 天的 candidate 数量，判定 tier。 */
export function computeTier(recent7d: number, prior7d: number, total: number): TopicTier {
  if (total < TOPIC_THRESHOLDS.minCandidates) return 'emerging';
  if (recent7d >= TOPIC_THRESHOLDS.minCandidates * 2) return 'hot';
  if (recent7d > prior7d) return 'warming';
  return 'emerging';
}

/** slug 化：lower-case, hyphenated, 去 non-alnum。 */
export function toSlug(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
