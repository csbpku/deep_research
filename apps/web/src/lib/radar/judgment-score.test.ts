import { describe, expect, it, vi } from 'vitest';
import { RADAR_JUDGMENT_FEEDBACK_TYPES } from '@deep-research/shared/states';
import {
  RADAR_JUDGMENT_SCORE_BOUND,
  RADAR_JUDGMENT_SCORE_WEIGHTS,
  RADAR_LIST_ORDER_BY,
  computeRadarJudgmentScore,
  computeRadarJudgmentScoreFromGroups,
  isRadarJudgmentType,
  lockJudgmentAggregate,
  recomputeSummaryJudgmentScore,
} from './judgment-score';

describe('radar judgment scoring', () => {
  it('keeps the four judgment weights explicit', () => {
    expect(RADAR_JUDGMENT_SCORE_WEIGHTS).toEqual({
      pilot: 2,
      later: 1,
      read: -1,
      inaccurate: -2,
    });
    expect(Object.keys(RADAR_JUDGMENT_SCORE_WEIGHTS).sort()).toEqual(
      [...RADAR_JUDGMENT_FEEDBACK_TYPES].sort(),
    );
    expect(RADAR_JUDGMENT_SCORE_BOUND).toBe(20);
  });

  it('treats no feedback (legacy rows) as zero', () => {
    expect(computeRadarJudgmentScore({})).toBe(0);
    expect(computeRadarJudgmentScore({ pilot: 0, later: 0, read: 0, inaccurate: 0 })).toBe(0);
  });

  it('scores each judgment with its signed weight', () => {
    expect(computeRadarJudgmentScore({ pilot: 1 })).toBe(2);
    expect(computeRadarJudgmentScore({ later: 1 })).toBe(1);
    expect(computeRadarJudgmentScore({ read: 1 })).toBe(-1);
    expect(computeRadarJudgmentScore({ inaccurate: 1 })).toBe(-2);
  });

  it('sums mixed judgments', () => {
    // 2*2 + 1 - 1 - 2 = 2
    expect(
      computeRadarJudgmentScore({ pilot: 2, later: 1, read: 1, inaccurate: 1 }),
    ).toBe(2);
  });

  it('ignores non-judgment feedback types', () => {
    expect(
      computeRadarJudgmentScore({
        useful: 100,
        used: 100,
        favorite: 100,
        suggest_research: 100,
      } as Record<string, number>),
    ).toBe(0);
  });

  it('clamps the crowd score to the safety bound', () => {
    expect(computeRadarJudgmentScore({ pilot: 11 })).toBe(RADAR_JUDGMENT_SCORE_BOUND);
    expect(computeRadarJudgmentScore({ inaccurate: 11 })).toBe(-RADAR_JUDGMENT_SCORE_BOUND);
  });

  it('narrows judgment types and rejects everything else', () => {
    for (const type of ['read', 'later', 'pilot', 'inaccurate']) {
      expect(isRadarJudgmentType(type)).toBe(true);
    }
    for (const type of ['useful', 'favorite', 'used', 'suggest_research', 'not_a_type']) {
      expect(isRadarJudgmentType(type)).toBe(false);
    }
  });

  it('derives the score from groupBy rows and ignores unknown groups', () => {
    expect(
      computeRadarJudgmentScoreFromGroups([
        { feedbackType: 'pilot', _count: { feedbackType: 2 } },
        { feedbackType: 'read', _count: { feedbackType: 1 } },
        { feedbackType: 'favorite', _count: { feedbackType: 7 } },
      ]),
    ).toBe(3);
    expect(computeRadarJudgmentScoreFromGroups([])).toBe(0);
  });

  it('serializes recomputes with a transaction-scoped advisory lock', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    await lockJudgmentAggregate({ $queryRaw: queryRaw }, 'summary-1');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0][0].join('?')).toContain('pg_advisory_xact_lock');
    expect(queryRaw.mock.calls[0][1]).toBe('summary-1');
  });

  it('recomputes and writes the aggregate inside the caller transaction', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { feedbackType: 'pilot', _count: { feedbackType: 1 } },
      { feedbackType: 'later', _count: { feedbackType: 1 } },
      { feedbackType: 'useful', _count: { feedbackType: 3 } },
    ]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    const score = await recomputeSummaryJudgmentScore(
      {
        radarFeedback: { groupBy },
        summary: { updateMany },
      } as never,
      'summary-1',
    );

    expect(score).toBe(3);
    expect(groupBy).toHaveBeenCalledWith({
      by: ['feedbackType'],
      where: { summaryId: 'summary-1' },
      _count: { feedbackType: true },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'summary-1' },
      data: { judgmentScore: 3 },
    });
  });

  it('does not throw when the summary was deleted before the write', async () => {
    const score = await recomputeSummaryJudgmentScore(
      {
        radarFeedback: { groupBy: vi.fn().mockResolvedValue([]) },
        summary: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      } as never,
      'missing-summary',
    );
    expect(score).toBe(0);
  });

  it('keeps quality first, then judgment, then stable tie-breakers', () => {
    expect(RADAR_LIST_ORDER_BY).toEqual([
      { distilledTotal: { sort: 'desc', nulls: 'last' } },
      { judgmentScore: 'desc' },
      { createdAt: 'desc' },
      { id: 'asc' },
    ]);
  });
});
