import { describe, expect, it } from 'vitest';

import { getPersonalContextSearchQuery, idsToContextRefs, mergePersonalContextItems } from './AiResearchBrief';

describe('AI research context selection', () => {
  const suggestions = [
    {
      kind: 'knowledge' as const,
      id: 'private-knowledge-1',
      title: 'Private judgement',
      snippet: 'Only the confirmed judgement',
      private: true,
      semanticMatch: true,
      sourceRefs: [{ type: 'research' as const, value: 'private-knowledge-1', required: false }],
    },
    {
      kind: 'research' as const,
      id: 'private-report-2',
      title: 'Private report',
      snippet: 'A separate draft',
      private: true,
      sourceRefs: [{ type: 'research' as const, value: 'private-report-2', required: false }],
    },
  ];

  it('does not inject suggested knowledge until the user selects it', () => {
    expect(idsToContextRefs([], [
      { type: 'url', value: 'https://example.com/explicit', required: false },
      { type: 'research', value: 'seed-research', required: false },
    ], suggestions)).toEqual([
      { type: 'url', value: 'https://example.com/explicit', required: false },
    ]);
  });

  it('adds only the selected item and its source refs', () => {
    expect(idsToContextRefs(['private-knowledge-1'], [], suggestions)).toEqual([
      { type: 'research', value: 'private-knowledge-1', required: false },
    ]);
  });

  it('keeps selected candidates available when the active query results change', () => {
    const nextQueryResults = [{
      kind: 'research' as const,
      id: 'another-result',
      title: 'Another result',
      snippet: 'Current query result',
    }];

    expect(mergePersonalContextItems([], nextQueryResults, [suggestions[0]!])).toEqual([
      nextQueryResults[0],
      suggestions[0],
    ]);
  });

  it('defers semantic lookup until the optional context panel is opened', () => {
    expect(getPersonalContextSearchQuery(false, '', 'How should we validate retrieval?')).toBeNull();
    expect(getPersonalContextSearchQuery(true, '', '  How should we validate retrieval?  ')).toBe(
      'How should we validate retrieval?',
    );
    expect(getPersonalContextSearchQuery(true, '  private notes  ', 'Research question')).toBe('private notes');
    expect(getPersonalContextSearchQuery(true, '', 'x')).toBeNull();
  });
});
