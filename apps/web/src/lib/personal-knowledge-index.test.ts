import { describe, expect, it, vi } from 'vitest';

import {
  confirmedKnowledgeIndexText,
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
