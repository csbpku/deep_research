export const RESEARCH_TABS = ['research', 'knowledge', 'mine', 'draft'] as const;

export type ResearchTab = (typeof RESEARCH_TABS)[number];

/** 把 URL 中不可信的 tab 值收敛到调研库支持的四个视图。 */
export function parseResearchTab(value: string | null | undefined): ResearchTab {
  return RESEARCH_TABS.includes(value as ResearchTab) ? (value as ResearchTab) : 'research';
}

/** 生成可刷新、可分享的调研库 tab 链接；默认页保持短 URL。 */
export function researchTabHref(tab: ResearchTab): string {
  return tab === 'research' ? '/researches' : `/researches?tab=${tab}`;
}
