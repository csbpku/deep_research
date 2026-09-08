export const RESEARCH_TABS = ['research', 'knowledge', 'mine', 'draft'] as const;

export type ResearchTab = (typeof RESEARCH_TABS)[number];
export const RESEARCH_VIEWS = ['published', 'draft', 'mine'] as const;
export type ResearchView = (typeof RESEARCH_VIEWS)[number];

/** 把 URL 中不可信的 tab 值收敛到调研库支持的四个视图。 */
export function parseResearchTab(value: string | null | undefined): ResearchTab {
  return RESEARCH_TABS.includes(value as ResearchTab) ? (value as ResearchTab) : 'research';
}

/** 把旧的内容类型 URL 映射到新的状态视图。 */
export function researchViewForTab(tab: ResearchTab): ResearchView {
  if (tab === 'draft') return 'draft';
  if (tab === 'mine') return 'mine';
  return 'published';
}

/** 旧的 ?tab=knowledge / ?tab=research 仍可保留类型筛选语义。 */
export function researchTypeForTab(tab: ResearchTab): 'all' | 'research' | 'knowledge' {
  if (tab === 'knowledge') return 'knowledge';
  if (tab === 'research') return 'research';
  return 'all';
}

/** 生成可刷新、可分享的调研库 tab 链接；默认页保持短 URL。 */
export function researchTabHref(tab: ResearchTab | ResearchView): string {
  return tab === 'research' || tab === 'published'
    ? '/researches'
    : `/researches?tab=${tab}`;
}
