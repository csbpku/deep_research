import { describe, expect, it } from 'vitest';

import { topicLookupKeys } from './topics';

describe('topicLookupKeys', () => {
  it('keeps plain slug as-is', () => {
    expect(topicLookupKeys('rag-system')).toEqual(['rag-system']);
  });

  it('adds decoded form for URL-encoded Chinese slug', () => {
    const encoded = encodeURIComponent('RAG 系统的上下文');
    expect(topicLookupKeys(encoded)).toEqual([encoded, 'RAG 系统的上下文']);
  });

  it('keeps malformed percent sequences without throwing', () => {
    expect(topicLookupKeys('%E4%B8%AD%')).toEqual(['%E4%B8%AD%']);
  });
});
