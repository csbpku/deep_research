import { describe, expect, it, vi } from 'vitest';
import { RESEARCH_STATUS } from '@deep-research/shared/states';
import { ResearchRestoreReviewRequiredError, transitionResearchStatus } from './research-status-actions';
import { hashResearchRevision } from './research-revision';

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


describe('transitionResearchStatus aggregate restore gate', () => {
  it('does not let a clean zero-claim run erase an older high-risk conflict', async () => {
    const fields = {
      id: '33333333-3333-4333-8333-333333333333',
      authorId: '11111111-1111-4111-8111-111111111111',
      type: 'research',
      status: RESEARCH_STATUS.ARCHIVED,
      publishedAt: new Date('2026-11-01T00:00:00.000Z'),
      creationMethod: 'ai_research',
      title: 'AI report',
      body: 'Current body',
      background: '背景',
      conclusion: '结论',
      risks: '风险',
      tags: [],
      reviewStatus: 'passed',
    };
    const revisionHash = hashResearchRevision(fields);
    const tx = {
      research: {
        findUnique: vi.fn().mockResolvedValue({
          ...fields,
          sourceAiJob: null,
          reviewRuns: [
            {
              id: 'run-clean', revisionHash, executionStatus: 'completed', outcome: 'clear',
              attempt: 2, summary: null, claims: [], decisions: [],
            },
            {
              id: 'run-conflict', revisionHash, executionStatus: 'completed', outcome: 'blocked',
              attempt: 1, summary: null,
              claims: [{
                claim_id: 'c1', claim: '版本号必须写死', risk: 'high',
                verdict: 'contradicted', evidence: null,
              }],
              decisions: [],
            },
          ],
        }),
        update: vi.fn(),
      },
      researchAudit: { create: vi.fn() },
    };

    await expect(transitionResearchStatus(tx as never, {
      id: fields.id,
      actorId: fields.authorId,
      action: 'restore',
    })).rejects.toBeInstanceOf(ResearchRestoreReviewRequiredError);
    expect(tx.research.update).not.toHaveBeenCalled();
  });
});


describe('transitionResearchStatus with a queued re-review', () => {
  it('restores from the last completed review instead of deadlocking on a queued run', async () => {
    const fields = {
      id: '44444444-4444-4444-8444-444444444444',
      authorId: '11111111-1111-4111-8111-111111111111',
      type: 'research',
      status: RESEARCH_STATUS.ARCHIVED,
      publishedAt: new Date('2026-11-01T00:00:00.000Z'),
      creationMethod: 'ai_research',
      title: 'Queued review report',
      body: 'Reviewed body',
      background: null,
      conclusion: null,
      risks: null,
      tags: [],
      reviewStatus: 'queued',
    };
    const revisionHash = hashResearchRevision(fields);
    const tx = {
      research: {
        findUnique: vi.fn().mockResolvedValue({
          ...fields,
          sourceAiJob: null,
          reviewRuns: [
            {
              id: 'run-queued', revisionHash, executionStatus: 'queued', outcome: null,
              attempt: 2, summary: null, claims: [], decisions: [],
            },
            {
              id: 'run-clear', revisionHash, executionStatus: 'completed', outcome: 'clear',
              attempt: 1, summary: { coverage_status: 'complete' }, claims: [], decisions: [],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({
          id: fields.id, status: RESEARCH_STATUS.PUBLISHED, updatedAt: new Date(),
        }),
      },
      researchAudit: { create: vi.fn() },
    };

    await transitionResearchStatus(tx as never, {
      id: fields.id,
      actorId: fields.authorId,
      action: 'restore',
    });

    expect(tx.research.update).toHaveBeenCalledTimes(1);
  });
});
