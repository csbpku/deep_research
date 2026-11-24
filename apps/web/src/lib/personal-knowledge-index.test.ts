import { describe, expect, it, vi } from 'vitest';

import {
  confirmedKnowledgeIndexText,
  knowledgeCardIndexText,
  queuePersonalKnowledgeIndex,
  readingKnowledgeIndexText,
  readingKnowledgeIndexTextFromBody,
} from './personal-knowledge-index';

describe('personal knowledge index text', () => {
  it('indexes confirmed Reader notes and AI conclusions, not the quoted source section', () => {
    const body = [
      '## 原文摘录',
      'Full page source text must remain in the database only.',
      '## 我的笔记',
      'My confirmed engineering judgement.',
      '## AI 解读',
      'The API retries with bounded backoff.',
    ].join('\n\n');

    const indexed = readingKnowledgeIndexTextFromBody(body);

    expect(indexed).toContain('My confirmed engineering judgement.');
    expect(indexed).toContain('The API retries with bounded backoff.');
    expect(indexed).not.toContain('Full page source text');
  });

  it('does not create vector text for an excerpt-only Reader save', () => {
    expect(readingKnowledgeIndexText('  ', null)).toBeNull();
  });

  it('builds AI knowledge text only from the user-confirmed card fields', () => {
    expect(confirmedKnowledgeIndexText({
      title: ' A bounded conclusion ',
      conclusion: ' Start with a narrow retrieval scope. ',
      body: 'The evidence supports this only for small teams.',
    })).toBe('A bounded conclusion\n\nStart with a narrow retrieval scope.\n\nThe evidence supports this only for small teams.');
  });

  it('indexes the judgement and its scope before the supporting note', () => {
    const text = confirmedKnowledgeIndexText({
      title: 'GitNexus',
      judgement: 'Cross-repository call graphs are its main use.',
      judgementConfidence: 'medium',
      judgementScope: 'Only indexed repositories.',
      body: 'The demo showed symbol-level navigation.',
    });
    expect(text).toContain('Cross-repository call graphs are its main use.');
    expect(text).toContain('适用边界：Only indexed repositories.');
    expect(text).toContain('置信度 medium');
  });

  it('keeps a Reader quote out of the indexed judgement card', () => {
    const body = '> Full page source text\n\n## 我的笔记\n\nOnly this note should be indexed.';
    const text = knowledgeCardIndexText({ title: 'Card', body, judgement: 'A reusable claim.', judgementConfidence: 'high' });
    expect(text).toContain('A reusable claim.');
    expect(text).toContain('Only this note should be indexed.');
    expect(text).not.toContain('Full page source text');
  });

  it('keeps the complete confirmed text instead of stopping at 12k characters', () => {
    const body = `${'full evidence '.repeat(1_000)}END_OF_DOCUMENT`;
    expect(confirmedKnowledgeIndexText({ title: 'Long note', body })).toContain('END_OF_DOCUMENT');
    expect(confirmedKnowledgeIndexText({ title: 'Long note', body }).length).toBeGreaterThan(12_000);
  });
});

describe('personal knowledge index outbox', () => {
  it('queues idempotent upserts and increments the generation for newer edits', async () => {
    const upsert = vi.fn();
    await queuePersonalKnowledgeIndex({ personalKnowledgeIndexTask: { upsert } } as never, {
      ownerId: '11111111-1111-4111-8111-111111111111',
      researchId: '22222222-2222-4222-8222-222222222222',
      operation: 'upsert',
    });

    expect(upsert).toHaveBeenCalledWith({
      where: { researchId: '22222222-2222-4222-8222-222222222222' },
      create: expect.objectContaining({ operation: 'upsert', generation: 1, status: 'queued' }),
      update: expect.objectContaining({
        operation: 'upsert',
        status: 'queued',
        generation: { increment: 1 },
        attempts: 0,
        nextRetryAt: null,
      }),
    });
  });
});
