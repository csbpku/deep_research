import { describe, expect, it } from 'vitest';

import { DetailReadCompletedInput, RecordTimeSavedInput, ResearchBriefSchema, ResearchScopeSchema } from './schemas';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

describe('metric input schemas', () => {
  it('accepts a completed detail read at both thresholds', () => {
    expect(DetailReadCompletedInput.safeParse({
      entityType: 'research',
      entityId: UUID,
      foregroundSeconds: 30,
      scrollPercent: 50,
      idempotencyKey: UUID,
    }).success).toBe(true);
  });

  it('rejects detail reads below either threshold', () => {
    expect(DetailReadCompletedInput.safeParse({
      entityType: 'summary',
      entityId: UUID,
      foregroundSeconds: 29,
      scrollPercent: 50,
      idempotencyKey: UUID,
    }).success).toBe(false);
    expect(DetailReadCompletedInput.safeParse({
      entityType: 'summary',
      entityId: UUID,
      foregroundSeconds: 30,
      scrollPercent: 49,
      idempotencyKey: UUID,
    }).success).toBe(false);
  });

  it('bounds time-saved feedback to 0-240 minutes', () => {
    expect(RecordTimeSavedInput.safeParse({ jobId: UUID, minutes: 0, idempotencyKey: UUID }).success)
      .toBe(true);
    expect(RecordTimeSavedInput.safeParse({ jobId: UUID, minutes: 240, idempotencyKey: UUID }).success)
      .toBe(true);
    expect(RecordTimeSavedInput.safeParse({ jobId: UUID, minutes: 241, idempotencyKey: UUID }).success)
      .toBe(false);
  });
});

describe('research scope schema', () => {
  it('defaults to an explicit unrestricted scope', () => {
    expect(ResearchScopeSchema.parse({})).toEqual({
      timeRange: { preset: 'any' },
      regions: [],
      technologyVersions: [],
      retrievalNotes: '',
    });
  });

  it('requires both dates for a custom range and keeps dates ordered', () => {
    expect(ResearchScopeSchema.safeParse({ timeRange: { preset: 'custom', from: '2026-09-02' } }).success).toBe(false);
    expect(ResearchScopeSchema.safeParse({ timeRange: { preset: 'custom', from: '2026-09-03', to: '2026-09-02' } }).success).toBe(false);
    expect(ResearchScopeSchema.safeParse({
      timeRange: { preset: 'custom', from: '2026-09-01', to: '2026-09-30' },
      regions: ['中国'],
      technologyVersions: ['React 19'],
      retrievalNotes: '只看官方资料',
    }).success).toBe(true);
  });

  it('keeps the scope inside a research brief', () => {
    const result = ResearchBriefSchema.safeParse({
      objective: 'decide',
      question: '选择一个测试框架',
      scope: { timeRange: { preset: '30d' }, regions: ['全球'], technologyVersions: ['Node 22'] },
    });
    expect(result.success).toBe(true);
  });
});
