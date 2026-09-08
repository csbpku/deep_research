/**
 * Radar / 搜索结果共用的来源类型 -> 中文 label。
 *
 * 设计原则：
 *   - 用户看到的永远是中文短名 + 全名（hover / tooltip / aria-label）
 *   - 后端传入的 sourceType 是枚举字符串（snake_case），UI 不直接暴露
 *   - 未知值回落到「其他」+ 原值兜底，避免静默丢信息
 *
 * 同时导出 SOURCE_TYPE_FILTER_OPTIONS 给列表筛选下拉框共用，不再让
 * radar/page.tsx 自己维护一份重复的映射。
 */
export interface SourceLabel {
  short: string;
  full: string;
}

export interface RadarContentLabel {
  short: string;
  full: string;
}

export type RadarSourceCategory = 'github' | 'research' | 'articles' | 'community' | 'shared';

export const RADAR_RESEARCH_SOURCE_TYPES = ['arxiv', 'huggingface_papers'] as const;
export const RADAR_ARTICLE_SOURCE_TYPES = [
  'rss',
  'devto',
  'vendor_news',
  'vendor_changelog',
  'wechat',
  'sitemap_watch',
] as const;
export const RADAR_COMMUNITY_SOURCE_TYPES = ['hackernews', 'producthunt', 'reddit', 'lobsters'] as const;

export const RADAR_SOURCE_CATEGORY_OPTIONS: ReadonlyArray<{
  value: RadarSourceCategory;
  label: string;
}> = [
  { value: 'github', label: 'GitHub' },
  { value: 'research', label: '研究论文' },
  { value: 'articles', label: '技术文章' },
  { value: 'community', label: '社区动态' },
  { value: 'shared', label: '用户分享' },
];

export function isHackerNewsSourceName(sourceName: string | null | undefined): boolean {
  if (!sourceName) return false;
  return /hacker[\s_-]*news/i.test(sourceName);
}

export function toRadarSourceCategory(
  sourceType: string | null | undefined,
  sourceName?: string | null,
): RadarSourceCategory | null {
  if (!sourceType) return null;
  if (sourceType.startsWith('github')) return 'github';
  if ((RADAR_RESEARCH_SOURCE_TYPES as readonly string[]).includes(sourceType)) return 'research';
  if ((RADAR_COMMUNITY_SOURCE_TYPES as readonly string[]).includes(sourceType)) return 'community';
  if ((RADAR_ARTICLE_SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    return isHackerNewsSourceName(sourceName) ? 'community' : 'articles';
  }
  if (sourceType === 'web_share') return 'shared';
  return null;
}

const SOURCE_LABEL_MAP: Record<string, SourceLabel> = {
  github: { short: 'GitHub', full: 'GitHub（仓库 / Issue / PR）' },
  github_repo: { short: 'GitHub 仓库', full: 'GitHub 仓库摘要' },
  github_issue: { short: 'GitHub Issue', full: 'GitHub Issue' },
  github_pr: { short: 'GitHub PR', full: 'GitHub Pull Request' },
  github_release: { short: 'GitHub Release', full: 'GitHub Release Notes' },
  github_trending: { short: 'GitHub 趋势', full: 'GitHub Trending' },
  github_topic_search: { short: 'GitHub 话题', full: 'GitHub 话题搜索' },
  github_other: { short: 'GitHub 其他', full: 'GitHub 其他来源' },
  articles: { short: '技术文章', full: 'RSS、工程博客与厂商文章' },
  community: { short: '社区动态', full: 'Hacker News、Product Hunt 与社区讨论' },
  arxiv: { short: 'arXiv', full: 'arXiv 论文' },
  huggingface_papers: { short: 'Hugging Face', full: 'Hugging Face Daily Papers' },
  rss: { short: 'RSS', full: 'RSS / 博客订阅' },
  hackernews: { short: 'Hacker News', full: 'Hacker News 讨论' },
  producthunt: { short: 'Product Hunt', full: 'Product Hunt 今日发布' },
  reddit: { short: 'Reddit', full: 'Reddit 子版块' },
  devto: { short: 'Dev.to', full: 'Dev.to 博文' },
  vendor_news: { short: '厂商新闻', full: '厂商官方新闻 / 博客' },
  vendor_changelog: { short: '厂商变更', full: '厂商官方变更日志' },
  huggingface_models: { short: 'Hugging Face 模型', full: 'Hugging Face 模型动态' },
  lobsters: { short: 'Lobste.rs', full: 'Lobste.rs 社区' },
  web: { short: '网页', full: '网页抓取' },
  web_share: { short: '用户分享', full: '用户分享的网页' },
};

const FALLBACK: SourceLabel = { short: '其他', full: '其他来源' };

export function formatSourceType(type: string | null | undefined): SourceLabel {
  if (!type) return FALLBACK;
  return SOURCE_LABEL_MAP[type] ?? { short: type, full: type };
}

/**
 * The source that discovered an item and the shape the user is about to read
 * are different facts. Keep them separate so a repository found by a curated
 * feed does not get presented as an article, and a shared Reddit link does not
 * look like a generic web page.
 */
export function formatRadarContentKind(
  originalKind: string | null | undefined,
  sourceType: string | null | undefined,
  url?: string | null,
): RadarContentLabel {
  if (originalKind === 'github_repo') {
    return { short: '仓库', full: 'GitHub 仓库' };
  }
  if (originalKind === 'github_release') {
    return { short: '发布说明', full: 'GitHub 发布说明' };
  }
  if (originalKind === 'github_issue' || originalKind === 'github_pr' || originalKind === 'github_other') {
    return { short: 'GitHub 讨论', full: 'GitHub Issue / Pull Request' };
  }
  if (originalKind === 'arxiv') {
    return { short: '研究论文', full: '研究论文' };
  }
  if (sourceType && (RADAR_COMMUNITY_SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    return { short: '社区讨论', full: '社区讨论' };
  }
  if (sourceType && (RADAR_ARTICLE_SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    return { short: '技术文章', full: '技术文章' };
  }
  if (originalKind === 'web_share') {
    try {
      const hostname = new URL(url ?? '').hostname.toLowerCase();
      if (hostname === 'reddit.com' || hostname.endsWith('.reddit.com')
        || hostname === 'news.ycombinator.com'
        || hostname === 'producthunt.com' || hostname.endsWith('.producthunt.com')
        || hostname === 'lobste.rs') {
        return { short: '社区讨论', full: '社区讨论 / 用户分享' };
      }
    } catch {
      // Fall through to the generic shared-page label.
    }
    return { short: '用户分享', full: '用户分享的网页' };
  }
  if (originalKind === 'rss' || originalKind === 'article') {
    return { short: '技术文章', full: '技术文章' };
  }
  return { short: '网页', full: '网页内容' };
}

/** 给筛选下拉框用：值是后端枚举，label 是中文。 */
export const SOURCE_TYPE_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  ...RADAR_SOURCE_CATEGORY_OPTIONS,
];
