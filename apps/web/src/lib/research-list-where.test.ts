import { describe, expect, it } from 'vitest';
import { researchListWhere } from './research-list-where';

describe('researchListWhere needsReview', () => {
  it('only includes reports with an unsure or missed rating for this user', () => {
    const where = researchListWhere({ scope: 'published', userId: 'u1', needsReview: true });
    expect(where.AND).toEqual(expect.arrayContaining([
      { learningSelfChecks: { some: { userId: 'u1', rating: { in: ['unsure', 'missed'] } } } },
    ]));
  });

  it('leaves the query unchanged when the filter is off', () => {
    const where = researchListWhere({ scope: 'published', userId: 'u1' });
    expect(JSON.stringify(where)).not.toContain('learningSelfChecks');
  });
});

describe('researchListWhere judgementDue', () => {
  it('restricts the personal due queue to the same author as its badge', () => {
    const where = researchListWhere({ scope: 'mine', userId: 'u1', judgementDue: true });
    expect(where.AND).toEqual(expect.arrayContaining([
      { authorId: 'u1', status: { in: ['published', 'archived'] } },
      { type: 'knowledge', status: 'published', judgement: { not: null }, judgementReviewAt: { lte: expect.any(Date) } },
    ]));
  });
  it('only includes published knowledge cards with an expired judgement', () => {
    const where = researchListWhere({ scope: 'published', userId: 'u1', judgementDue: true });
    expect(where.AND).toEqual(expect.arrayContaining([
      { type: 'knowledge', status: 'published', judgement: { not: null }, judgementReviewAt: { lte: expect.any(Date) } },
    ]));
  });

  it('leaves the query unchanged when judgementDue is off', () => {
    const where = researchListWhere({ scope: 'published', userId: 'u1' });
    expect(JSON.stringify(where)).not.toContain('judgementReviewAt');
  });
});
