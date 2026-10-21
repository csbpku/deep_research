import { describe, expect, it } from 'vitest';
import { initialMeWorkspaceTab, isMeWorkspaceTab, ME_WORKSPACE_TABS } from './me-tabs';

describe('personal workspace tab URLs', () => {
  it.each(ME_WORKSPACE_TABS)('accepts the existing tab value %s', (tab) => {
    expect(isMeWorkspaceTab(tab)).toBe(true);
    expect(initialMeWorkspaceTab(tab)).toBe(tab);
  });

  it.each([null, '', 'unknown', 'research'])('defaults invalid tab value %s to drafts', (tab) => {
    expect(isMeWorkspaceTab(tab)).toBe(false);
    expect(initialMeWorkspaceTab(tab)).toBe('drafts');
  });
});
