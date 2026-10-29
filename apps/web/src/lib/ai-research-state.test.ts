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
    expect(stripResearchCitationMarkers('正在输出 [[cit')).toBe('正在输出 ');
    expect(stripResearchCitationMarkers('普通标记 [c')).toBe('普通标记 [c');
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

const completeDraft: ResearchDraft = {
  reportType: 'web_brief', reportLength: 'standard', sourcePolicy: 'only_user_sources', sourceUrls: ['https://example.com'], sourceDraft: '', input: '尚未发送的问题', seed: null,
  brief: { objective: 'decide', assistantMessage: '方案已准备好', suggestedContextIds: [], brief: {
    objective: 'decide', question: '比较 A 和 B', constraints: [], questionsToAnswer: ['比较异常与取消'], comparisonOptions: ['A', 'B'], decisionDimensions: ['异常传播'], successCriteria: [],
    sourcePolicy: 'only_user_sources', scope: { timeRange: { preset: 'any' }, regions: [], technologyVersions: [], retrievalNotes: '' }, outputType: 'web', contextRefs: [],
  } },
};

it('restores the complete editable brief without losing its explicit source boundary', () => {
  const storage = memoryStorage();
  expect(writeResearchDraft(storage, 'owner', 'chat', completeDraft)).toBe(true);
  expect(readResearchDraft(storage, 'owner', 'chat')).toEqual(completeDraft);
});

it.each([
  null, [], 42, { ...completeDraft, reportType: 'unknown' }, { ...completeDraft, reportLength: 'quick' },
  { ...completeDraft, sourcePolicy: 'unrestricted' }, { ...completeDraft, sourceUrls: Array(11).fill('https://example.com') },
  { ...completeDraft, sourceUrls: ['ftp://example.com'] }, { ...completeDraft, sourceDraft: 42 },
  { ...completeDraft, input: 'x'.repeat(20001) }, { ...completeDraft, seed: [] }, { ...completeDraft, brief: [] },
  { ...completeDraft, brief: {} },
  { ...completeDraft, brief: { ...completeDraft.brief, brief: { ...completeDraft.brief!.brief, scope: { timeRange: { preset: 'any' }, regions: [], technologyVersions: [], retrievalNotes: 42 } } } },
  { ...completeDraft, brief: { ...completeDraft.brief, objective: 'learn', brief: { ...completeDraft.brief!.brief, objective: 'decide' } } },
  { ...completeDraft, brief: { ...completeDraft.brief, brief: { ...completeDraft.brief!.brief, questionsToAnswer: 'broken' } } },
  { ...completeDraft, brief: { ...completeDraft.brief, brief: { ...completeDraft.brief!.brief, contextRefs: [{ type: 'url', value: 42 }] } } },
  { ...completeDraft, brief: { ...completeDraft.brief, brief: { ...completeDraft.brief!.brief, scope: { timeRange: { preset: 'forever' } } } } },
])('ignores malformed or unsupported stored configuration %#', (corrupt) => {
  const storage = memoryStorage();
  storage.setItem('ai-research-draft:v1:owner:chat', JSON.stringify(corrupt));
  expect(readResearchDraft(storage, 'owner', 'chat')).toBeNull();
});

it('validates saved selected-source mappings while accepting old drafts', () => {
  const storage = memoryStorage();
  const mapped = { ...completeDraft, brief: { ...completeDraft.brief!, selectedContextItems: [{ kind: 'issue' as const, id: 'issue', title: '专题', snippet: '', sourceRefs: [{ type: 'summary' as const, value: '11111111-1111-4111-8111-111111111111', required: false }] }] } };
  expect(writeResearchDraft(storage, 'owner', 'chat', mapped)).toBe(true);
  expect(readResearchDraft(storage, 'owner', 'chat')).toEqual(mapped);
  storage.setItem('ai-research-draft:v1:owner:chat', JSON.stringify({ ...mapped, brief: { ...mapped.brief, selectedContextItems: [{ kind: 'issue', id: 12 }] } }));
  expect(readResearchDraft(storage, 'owner', 'chat')).toBeNull();
  storage.setItem('ai-research-draft:v1:owner:chat', JSON.stringify({ ...mapped, brief: { ...mapped.brief, legacyContextSelection: { ids: ['x'], refs: [{ type: 'summary', value: 42 }] } } }));
  expect(readResearchDraft(storage, 'owner', 'chat')).toBeNull();
  expect(writeResearchDraft(storage, 'owner', 'chat', completeDraft)).toBe(true);
  expect(readResearchDraft(storage, 'owner', 'chat')).toEqual(completeDraft);
});

it('handles unavailable storage, oversized data and missing identities without leaking a draft', () => {
  const storage = memoryStorage();
  expect(writeResearchDraft(storage, '', 'chat', completeDraft)).toBe(false);
  expect(readResearchDraft(storage, 'owner', '')).toBeNull();
  expect(readResearchDraft({ ...storage, getItem: () => { throw new Error('storage blocked'); } }, 'owner', 'chat')).toBeNull();
  storage.setItem('ai-research-draft:v1:owner:chat', 'x'.repeat(100001));
  expect(readResearchDraft(storage, 'owner', 'chat')).toBeNull();
});

it('formats the short time boundaries and absent timestamps', () => {
  expect(formatResearchRelativeTime(null, now)).toBe('时间未知');
  expect(formatResearchRelativeTime(new Date(now - 30 * 60_000).toISOString(), now)).toBe('30 分钟前');
  expect(formatResearchRelativeTime(new Date(now - 3 * 60 * 60_000).toISOString(), now)).toBe('3 小时前');
});
