/** Internal processing metadata, not a reader-facing topic label. */
export const RADAR_FEED_EXCERPT_TAG = 'evidence_feed_excerpt';

export function visibleRadarTags(tags: readonly string[] | null | undefined): string[] {
  return (tags ?? []).filter((tag) => tag !== RADAR_FEED_EXCERPT_TAG);
}

/** Explain only what is known about the evidence used for this score. */
export function radarEvidenceNotice(detail: {
  tags?: readonly string[] | null;
  scoreReason?: string | null;
}): string {
  if (detail.tags?.includes(RADAR_FEED_EXCERPT_TAG)) {
    return '摘要与评分基于 RSS 来源片段，原文尚未核实；请打开原文复核。';
  }
  // Existing sync records used this durable prefix before the internal tag
  // existed. Match it only at the start, never an arbitrary score quote.
  if (detail.scoreReason?.trimStart().startsWith('来源摘要初筛：')) {
    return '摘要与评分基于来源摘要，未能取得原文正文；请打开原文复核。';
  }
  // Older scores do not reliably record the evidence scope. Do not imply a
  // verified full-text fetch merely because a score or an excerpt exists.
  return '摘要与评分基于同步时可用的资料；请打开原文或 Reader 核对。';
}
