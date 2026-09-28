import { describe, expect, it, vi } from 'vitest';
import { RESEARCH_STATUS } from '@deep-research/shared/states';
import { transitionResearchStatus } from './research-status-actions';

describe('transitionResearchStatus personal knowledge index lifecycle', () => {
  it('queues index cleanup when a knowledge card is archived', async () => {
    const indexUpsert = vi.fn();
    const tx = {
      research: {
        findUnique: vi.fn().mockResolvedValue({
          id: '22222222-2222-4222-8222-222222222222',
          authorId: '11111111-1111-4111-8111-111111111111',
          type: 'knowledge',
          status: RESEARCH_STATUS.PUBLISHED,
          publishedAt: new Date('2026-09-01T00:00:00.000Z'),
        }),
        update: vi.fn().mockResolvedValue({
          id: '22222222-2222-4222-8222-222222222222',
          status: RESEARCH_STATUS.ARCHIVED,
          updatedAt: new Date('2026-09-24T00:00:00.000Z'),
        }),
      },
      personalKnowledgeIndexTask: { upsert: indexUpsert },
      researchAudit: { create: vi.fn() },
    };

    await transitionResearchStatus(tx as never, {
      id: '22222222-2222-4222-8222-222222222222',
      actorId: '11111111-1111-4111-8111-111111111111',
      action: 'archive',
    });

    expect(indexUpsert).toHaveBeenCalledWith({
      where: { researchId: '22222222-2222-4222-8222-222222222222' },
      create: {
        ownerId: '11111111-1111-4111-8111-111111111111',
        researchId: '22222222-2222-4222-8222-222222222222',
        operation: 'delete',
        status: 'queued',
        generation: 1,
      },
      update: expect.objectContaining({ operation: 'delete', status: 'queued' }),
    });
  });
});
