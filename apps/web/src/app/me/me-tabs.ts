export const ME_WORKSPACE_TABS = [
  'drafts',
  'bookmarks',
  'templates',
  'notifications',
  'preferences',
] as const;

export type MeWorkspaceTab = typeof ME_WORKSPACE_TABS[number];

export function isMeWorkspaceTab(value: string | null): value is MeWorkspaceTab {
  return value !== null && (ME_WORKSPACE_TABS as readonly string[]).includes(value);
}

export function initialMeWorkspaceTab(value: string | null): MeWorkspaceTab {
  return isMeWorkspaceTab(value) ? value : 'drafts';
}
