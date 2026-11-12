// RadarReadingDetail —— 列表预览与详情 landing 共用的阅读概览数据契约。
//
// 这里只放纯函数与类型，不放 JSX：两个入口（RadarPreviewPanel 与
// RadarExternalReadingLanding）必须用同一套字段、同一套标签清洗和同一条
// Reader 深链规则，否则同一个 summary 在两个入口会呈现不同的信息。

import type { DistilledScore } from '@deep-research/shared/schemas';
import type { RadarFeedbackType } from '@deep-research/shared/states';

import type { RadarFeedbackCounts } from './RadarFeedbackBar';
import { visibleRadarTags } from '@/lib/radar/evidence';

/** The fields the reading overview needs; both surfaces receive this shape. */
export interface ExternalReadingDetail {
  id: string;
  title: string;
  excerpt: string;
  interpretation: string | null;
  scoreReason: string | null;
  distilledScore: DistilledScore | null;
  tier: string | null;
  selectionReason: string | null;
  url: string;
  sourceType: string | null;
  sourceName: string | null;
  originalKind?: string | null;
  tags?: string[];
  publishedAt?: string | null;
  isAuthenticated?: boolean;
  feedbackCounts?: RadarFeedbackCounts;
  myFeedbacks?: RadarFeedbackType[];
  /** Optional extracted source points; not every radar item has enrichment. */
  highlights?: {
    summary: string;
    highlights: string[];
    keyQuote: string | null;
  } | null;
}

export function externalReaderUrl(
  sourceUrl: string,
  summaryId: string,
  platformUrl?: string | null,
): string {
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return sourceUrl;
    url.searchParams.set('deep-research-source', 'radar');
    url.searchParams.set('deep-research-summary', summaryId);
    if (platformUrl) {
      const platform = new URL(platformUrl);
      if (platform.protocol === 'http:' || platform.protocol === 'https:') {
        url.searchParams.set('deep-research-platform', platform.origin);
      }
    }
    return url.toString();
  } catch {
    return sourceUrl;
  }
}

export function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function formatRadarDetailDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function cleanRadarTags(tags: string[] | undefined): string[] {
  return visibleRadarTags(tags).filter((tag) => {
    if (!tag || tag.startsWith('tier_') || tag.startsWith('profile_')) return false;
    if (tag.startsWith('veto_') || tag.startsWith('risk_')) return false;
    if (tag.startsWith('migration_') || tag.endsWith('_pending')) return false;
    return ![
      'rss',
      'api',
      'web',
      'github',
      'tracked',
      'repo_digest',
      'external_reading',
      'content_pending',
      'fetch_failed_shell',
      'paywall_stub',
    ].includes(tag);
  }).slice(0, 4);
}

export function radarSummaryParts(detail: Pick<ExternalReadingDetail, 'excerpt' | 'interpretation'>) {
  const interpretation = detail.interpretation?.trim() || null;
  const excerpt = detail.excerpt?.trim() || null;
  const lead = interpretation || excerpt || '雷达暂未生成一句话判断。';
  const supportingExcerpt = interpretation
    && excerpt
    && excerpt !== interpretation
    && !excerpt.startsWith(interpretation)
    && !interpretation.startsWith(excerpt)
    ? excerpt
    : null;

  return { lead, supportingExcerpt };
}

/** Reading tier/quality shown on both the panel and the landing page. */
export function radarReadingTier(detail: Pick<ExternalReadingDetail, 'tier' | 'distilledScore'>) {
  return detail.tier ?? detail.distilledScore?.tier ?? null;
}
