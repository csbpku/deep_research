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

export type RadarSourceCategory = 'github' | 'research' | 'articles' | 'community' | 'shared';

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

export function toRadarSourceCategory(sourceType: string | null | undefined): RadarSourceCategory | null {
  if (!sourceType) return null;
  if (sourceType.startsWith('github')) return 'github';
  if (sourceType === 'arxiv') return 'research';
  if (['rss', 'devto', 'vendor_news', 'wechat', 'sitemap_watch'].includes(sourceType)) return 'articles';
  if (['hackernews', 'producthunt', 'reddit', 'lobsters'].includes(sourceType)) return 'community';
  if (sourceType === 'web_share') return 'shared';
  return null;
}

const SOURCE_LABEL_MAP: Record<string, SourceLabel> = {
  github: { short: 'GitHub', full: 'GitHub（仓库 / Issue / PR）' },
  github_repo: { short: 'GitHub 仓库', full: 'GitHub 仓库摘要' },
  github_release: { short: 'GitHub Release', full: 'GitHub Release Notes' },
  github_trending: { short: 'GitHub 趋势', full: 'GitHub Trending' },
  github_topic_search: { short: 'GitHub 话题', full: 'GitHub 话题搜索' },
  github_other: { short: 'GitHub 其他', full: 'GitHub 其他来源' },
  articles: { short: '技术文章', full: 'RSS、工程博客与厂商文章' },
  community: { short: '社区动态', full: 'Hacker News、Product Hunt 与社区讨论' },
  arxiv: { short: 'arXiv', full: 'arXiv 论文' },
  rss: { short: 'RSS', full: 'RSS / 博客订阅' },
  hackernews: { short: 'Hacker News', full: 'Hacker News 讨论' },
  producthunt: { short: 'Product Hunt', full: 'Product Hunt 今日发布' },
  reddit: { short: 'Reddit', full: 'Reddit 子版块' },
  devto: { short: 'Dev.to', full: 'Dev.to 博文' },
  vendor_news: { short: '厂商新闻', full: '厂商官方新闻 / 博客' },
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

/** 给筛选下拉框用：值是后端枚举，label 是中文。 */
export const SOURCE_TYPE_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  ...RADAR_SOURCE_CATEGORY_OPTIONS,
];
