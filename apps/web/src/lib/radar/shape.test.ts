// Unit tests: W5 雷达 shape helper —— excerpt / parseUtcDate / isoDateOf / matchesQuery。
//
// 测试范围：
//   - excerpt 边界（短、长、有/无句号）
//   - parseUtcDate / isoDateOf 互逆
//   - matchesQuery 大小写、tag 命中、未命中
//   - aggregateFeedbacks 仅测试 counts/mine 聚合（mock prisma）

import { describe, expect, it, vi } from 'vitest';
import {
  excerptOf,
  parseUtcDate,
  isoDateOf,
  matchesQuery,
  aggregateFeedbacks,
  emptyFeedbackCounts,
  RADAR_FEEDBACK_TYPES,
} from './shape';

describe('excerptOf', () => {
  it('returns full body when shorter than max', () => {
    expect(excerptOf('Hello world.', 280)).toBe('Hello world.');
  });

  it('truncates at sentence boundary', () => {
    const long = 'First sentence. Second sentence is here. Third follows.';
    const result = excerptOf(long, 30);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result.endsWith('.')).toBe(true);
  });

  it('hard truncates with ellipsis if no boundary found', () => {
    const long = 'a'.repeat(500);
    const r = excerptOf(long, 50);
    expect(r.length).toBe(50);
    expect(r.endsWith('…')).toBe(true);
  });
});

describe('parseUtcDate / isoDateOf', () => {
  it('parseUtcDate returns UTC midnight', () => {
    const d = parseUtcDate('2026-07-21');
    expect(d.toISOString()).toBe('2026-07-21T00:00:00.000Z');
  });

  it('isoDateOf returns YYYY-MM-DD', () => {
    const d = new Date(Date.UTC(2026, 0, 5));
    expect(isoDateOf(d)).toBe('2026-01-05');
  });

  it('parse → iso roundtrip is stable', () => {
    expect(isoDateOf(parseUtcDate('2026-12-31'))).toBe('2026-12-31');
  });
});

describe('matchesQuery', () => {
  it('returns true when query is empty', () => {
    expect(matchesQuery({ query: undefined, title: 'X', interpretation: null, tags: [] })).toBe(true);
    expect(matchesQuery({ query: '', title: 'X', interpretation: null, tags: [] })).toBe(true);
  });

  it('matches title (case insensitive)', () => {
    expect(matchesQuery({
      query: 'RAG',
      title: 'RAG retrieval strategies',
      interpretation: null,
      tags: [],
    })).toBe(true);
    expect(matchesQuery({
      query: 'rag',
      title: 'RAG retrieval strategies',
      interpretation: null,
      tags: [],
    })).toBe(true);
  });

  it('matches interpretation', () => {
    expect(matchesQuery({
      query: 'vector',
      title: 'Foo',
      interpretation: 'covers vector store choices',
      tags: [],
    })).toBe(true);
  });

  it('matches tags', () => {
    expect(matchesQuery({
      query: 'postgres',
      title: 'Foo',
      interpretation: null,
      tags: ['Postgres', 'SQL'],
    })).toBe(true);
  });

  it('returns false on miss', () => {
    expect(matchesQuery({
      query: 'absent',
      title: 'Foo',
      interpretation: 'bar',
      tags: ['baz'],
    })).toBe(false);
  });
});

describe('RADAR_FEEDBACK_TYPES', () => {
  it('contains all five types', () => {
    expect([...RADAR_FEEDBACK_TYPES].sort()).toEqual(
      ['favorite', 'inaccurate', 'suggest_research', 'used', 'useful'],
    );
  });
});

describe('emptyFeedbackCounts', () => {
  it('returns all zero', () => {
    const c = emptyFeedbackCounts();
    expect(c).toEqual({ useful: 0, inaccurate: 0, used: 0, favorite: 0, suggest_research: 0 });
  });
});

describe('aggregateFeedbacks', () => {
  it('aggregates counts and current-user mine', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { summaryId: 'a', feedbackType: 'useful', _count: { feedbackType: 3 } },
      { summaryId: 'a', feedbackType: 'favorite', _count: { feedbackType: 1 } },
      { summaryId: 'b', feedbackType: 'useful', _count: { feedbackType: 2 } },
    ]);
    const findMany = vi.fn().mockResolvedValue([
      { summaryId: 'a', feedbackType: 'favorite' },
    ]);
    const fakePrisma = { radarFeedback: { groupBy, findMany } };

    const map = await aggregateFeedbacks(fakePrisma, ['a', 'b'], 'u1');

    expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['summaryId', 'feedbackType'],
      where: { summaryId: { in: ['a', 'b'] } },
    }));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { summaryId: { in: ['a', 'b'] }, userId: 'u1' },
    }));

    const a = map.get('a')!;
    expect(a.counts.useful).toBe(3);
    expect(a.counts.favorite).toBe(1);
    expect(a.mine).toEqual(['favorite']);

    const b = map.get('b')!;
    expect(b.counts.useful).toBe(2);
    expect(b.mine).toEqual([]);
  });

  it('returns empty map for empty input', async () => {
    const groupBy = vi.fn();
    const findMany = vi.fn();
    const fakePrisma = { radarFeedback: { groupBy, findMany } };
    const map = await aggregateFeedbacks(fakePrisma, [], 'u1');
    expect(map.size).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});
