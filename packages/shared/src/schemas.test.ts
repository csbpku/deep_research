import { describe, expect, it } from 'vitest';

import { DetailReadCompletedInput, RecordTimeSavedInput } from './schemas';

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
