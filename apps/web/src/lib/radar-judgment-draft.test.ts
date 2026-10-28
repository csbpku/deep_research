import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearJudgmentDraft,
  readJudgmentDraft,
  writeJudgmentDraft,
} from './radar-judgment-draft';

const SUMMARY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

/** vitest 跑在 node 环境，这里给一个最小的 localStorage 替身。 */
function createStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => { entries.delete(key); },
    setItem: (key: string, value: string) => { entries.set(key, value); },
  } as Storage;
}

describe('radar judgment draft', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: createStorage() });
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('keeps an unfinished note across dialog closes', () => {
    writeJudgmentDraft(SUMMARY_ID, '这是一段还没保存的判断草稿');

    expect(readJudgmentDraft(SUMMARY_ID)?.note).toBe('这是一段还没保存的判断草稿');
  });

  it('scopes drafts per radar item', () => {
    writeJudgmentDraft(SUMMARY_ID, '甲的判断');
    writeJudgmentDraft(OTHER_ID, '乙的判断');

    expect(readJudgmentDraft(SUMMARY_ID)?.note).toBe('甲的判断');
    expect(readJudgmentDraft(OTHER_ID)?.note).toBe('乙的判断');
  });

  it('treats a blank note as no draft', () => {
    writeJudgmentDraft(SUMMARY_ID, '   ');

    expect(readJudgmentDraft(SUMMARY_ID)).toBeNull();
  });

  it('drops the draft when the note is cleared', () => {
    writeJudgmentDraft(SUMMARY_ID, '先写一点');
    writeJudgmentDraft(SUMMARY_ID, '');

    expect(readJudgmentDraft(SUMMARY_ID)).toBeNull();
  });

  it('removes the draft on an explicit discard', () => {
    writeJudgmentDraft(SUMMARY_ID, '不想要的草稿');
    clearJudgmentDraft(SUMMARY_ID);

    expect(readJudgmentDraft(SUMMARY_ID)).toBeNull();
  });

  it('ignores corrupted storage entries instead of throwing', () => {
    window.localStorage.setItem(`dr:radar-judgment-draft:${SUMMARY_ID}`, '{not json');

    expect(readJudgmentDraft(SUMMARY_ID)).toBeNull();
  });
});
