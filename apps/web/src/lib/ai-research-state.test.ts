import { describe, expect, it } from 'vitest';
import { type ResearchDraft, formatResearchRelativeTime, stripResearchCitationMarkers, readResearchDraft, writeResearchDraft } from './ai-research-state';

const now = Date.parse('2026-10-28T00:00:00Z');
const isoDaysAgo = (n: number) => new Date(now - n * 86400000).toISOString();

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

describe('research state utilities', () => {
  it('formats one to 29 days without an impossible zero months', () => {
    expect(formatResearchRelativeTime(isoDaysAgo(7), now)).toBe('7 天前');
    expect(formatResearchRelativeTime(isoDaysAgo(29), now)).toBe('29 天前');
    expect(formatResearchRelativeTime(isoDaysAgo(30), now)).toBe('1 个月前');
    expect(formatResearchRelativeTime(new Date(now + 86400000).toISOString(), now)).toBe('刚刚');
    expect(formatResearchRelativeTime('not-a-date', now)).toBe('时间未知');
  });
  it('removes quote protocol markers while preserving quoted text', () => {
    expect(stripResearchCitationMarkers('前 [[cite]]原文[[/cite]] 后 [[cite]]残缺')).toBe('前 原文 后 残缺');
  });
  it('isolates drafts by account and conversation, and tolerates invalid data', () => {
    const storage = memoryStorage();
    const draft = { reportType: 'web_brief', reportLength: 'standard', sourcePolicy: 'prefer_user_sources', sourceUrls: ['https://example.com'], sourceDraft: '', input: '', brief: null, seed: { id: 'radar-1', title: '资料标题', url: 'https://example.com/source', interpretation: null, body: null } } satisfies ResearchDraft;
    expect(writeResearchDraft(storage, 'user-1', 'conversation-1', draft)).toBe(true);
    expect(readResearchDraft(storage, 'user-1', 'conversation-1')).toEqual(draft);
    expect(readResearchDraft(storage, 'user-2', 'conversation-1')).toBeNull();
    expect(readResearchDraft(storage, 'user-1', 'conversation-2')).toBeNull();
    storage.setItem('ai-research-draft:v1:user-1:conversation-1', JSON.stringify({ ...draft, seed: { id: 42 } }));
    expect(readResearchDraft(storage, 'user-1', 'conversation-1')).toBeNull();
    storage.setItem('ai-research-draft:v1:user-1:conversation-1', '{bad');
    expect(readResearchDraft(storage, 'user-1', 'conversation-1')).toBeNull();
    expect(writeResearchDraft({ ...storage, setItem: () => { throw new Error('blocked'); } }, 'user-1', 'conversation-1', draft)).toBe(false);
  });
});
