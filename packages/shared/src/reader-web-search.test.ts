import { describe, expect, it } from 'vitest';
import { ReadingAnswerSchema, ReadingSearchInputSchema, ReadingSessionStateSchema } from './schemas';

describe('Reader web search boundaries', () => {
  it('rejects article bodies and credentials in the search request contract', () => {
    expect(ReadingSearchInputSchema.safeParse({ question: 'Latest release?', title: 'Library' }).success).toBe(true);
    expect(ReadingSearchInputSchema.safeParse({ question: 'Latest?', body: 'Private article' }).success).toBe(false);
    expect(ReadingSearchInputSchema.safeParse({ question: 'Latest?', apiKey: 'private-key' }).success).toBe(false);
  });
  it('preserves per-turn web sources while keeping original evidence separate', () => {
    const source = { title: 'Releases', url: 'https://example.org/releases', snippet: 'Release notes' };
    const answer = ReadingAnswerSchema.parse({ answer: 'Original [1], external [W1]', evidence: [{ quote: 'Original text' }], webSources: [source], searchStatus: 'searched' });
    const state = ReadingSessionStateSchema.parse({ answerStructured: answer, discussion: [{ role: 'assistant', content: answer.answer, webSources: answer.webSources, searchStatus: answer.searchStatus }] });
    expect(state.discussion[0].webSources).toEqual([source]);
    expect(state.answerStructured?.evidence[0].quote).toBe('Original text');
    expect(ReadingAnswerSchema.safeParse({ answer: 'Text', webSources: [{ ...source, url: 'javascript:alert(1)' }] }).success).toBe(false);
  });
});
