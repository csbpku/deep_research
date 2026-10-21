import { describe, expect, it } from 'vitest';
import { shouldPollInlineResearch } from './InlineAiResearchStatus';

describe('inline AI research status polling', () => {
  it('continues polling and streaming while the independent review is queued or running', () => {
    expect(shouldPollInlineResearch({ status: 'succeeded', finalStatus: 'succeeded', review: { status: 'reviewing' } })).toBe(true);
    expect(shouldPollInlineResearch({ status: 'partial', finalStatus: 'partial', reviewRun: { executionStatus: 'queued' } })).toBe(true);
  });

  it('stops polling after both execution and review have settled', () => {
    expect(shouldPollInlineResearch({ status: 'succeeded', finalStatus: 'succeeded', review: { status: 'passed' } })).toBe(false);
    expect(shouldPollInlineResearch({ status: 'failed', finalStatus: 'failed', review: { status: 'unavailable' } })).toBe(false);
  });

  it('keeps polling while execution is active or the first response is pending', () => {
    expect(shouldPollInlineResearch(undefined)).toBe(true);
    expect(shouldPollInlineResearch({ status: 'running', finalStatus: null, review: null, reviewRun: null })).toBe(true);
  });
});
