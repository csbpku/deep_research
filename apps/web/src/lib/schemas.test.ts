// Unit tests: W5 雷达 / 反馈 / Admin Zod schemas。
//
// 契约源：apps/web/src/lib/schemas.ts §Week 5 雷达
// 测试覆盖：合法 / 非法入参；上下界。

import { describe, expect, it } from 'vitest';
import {
  RadarListQuery,
  RadarIdParam,
  CreateRadarFeedbackInput,
  DeleteRadarFeedbackQuery,
  RADAR_STATUS_VALUES,
  CreateCommentInput,
} from './schemas';

describe('RadarListQuery', () => {
  it('rejects q longer than 200', () => {
    expect(RadarListQuery.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
  });

  it('accepts q up to 200', () => {
    expect(RadarListQuery.safeParse({ q: 'x'.repeat(200) }).success).toBe(true);
  });

  it('accepts valid status values', () => {
    for (const s of RADAR_STATUS_VALUES) {
      expect(RadarListQuery.safeParse({ status: s }).success).toBe(true);
    }
  });

  it('rejects unknown status', () => {
    expect(RadarListQuery.safeParse({ status: 'nonsense' }).success).toBe(false);
  });

  it('rejects per_page > 50', () => {
    expect(RadarListQuery.safeParse({ per_page: 51 }).success).toBe(false);
  });

  it('rejects page < 1', () => {
    expect(RadarListQuery.safeParse({ page: 0 }).success).toBe(false);
  });

  it('defaults page=1, per_page=20', () => {
    const r = RadarListQuery.parse({});
    expect(r.page).toBe(1);
    expect(r.per_page).toBe(20);
  });

  it('trims q whitespace', () => {
    const r = RadarListQuery.parse({ q: '  AI  ' });
    expect(r.q).toBe('AI');
  });
});

describe('RadarIdParam', () => {
  it('accepts valid uuid', () => {
    expect(RadarIdParam.safeParse({ id: '11111111-1111-1111-1111-111111111111' }).success).toBe(true);
  });

  it('rejects non-uuid', () => {
    expect(RadarIdParam.safeParse({ id: 'not-uuid' }).success).toBe(false);
  });
});

describe('CreateRadarFeedbackInput', () => {
  it('accepts all 5 feedbackTypes', () => {
    for (const ft of ['useful', 'inaccurate', 'used', 'favorite', 'suggest_research']) {
      const r = CreateRadarFeedbackInput.safeParse({
        summaryId: '11111111-1111-1111-1111-111111111111',
        feedbackType: ft,
      });
      expect(r.success).toBe(true);
    }
  });

  it('rejects unknown feedbackType', () => {
    expect(CreateRadarFeedbackInput.safeParse({
      summaryId: '11111111-1111-1111-1111-111111111111',
      feedbackType: 'love',
    }).success).toBe(false);
  });

  it('rejects bad summaryId', () => {
    expect(CreateRadarFeedbackInput.safeParse({
      summaryId: 'xxx',
      feedbackType: 'useful',
    }).success).toBe(false);
  });
});

describe('DeleteRadarFeedbackQuery', () => {
  it('accepts valid query', () => {
    expect(DeleteRadarFeedbackQuery.safeParse({
      summaryId: '11111111-1111-1111-1111-111111111111',
      feedbackType: 'useful',
    }).success).toBe(true);
  });

  it('rejects invalid feedbackType', () => {
    expect(DeleteRadarFeedbackQuery.safeParse({
      summaryId: '11111111-1111-1111-1111-111111111111',
      feedbackType: 'bogus',
    }).success).toBe(false);
  });
});

describe('CreateCommentInput', () => {
  it('treats a null anchor as absent', () => {
    const result = CreateCommentInput.safeParse({
      body: 'hello',
      mentionedUserIds: [],
      anchor: null,
    });
    expect(result.success).toBe(true);
  });
});
