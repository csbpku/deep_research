import { describe, expect, it } from 'vitest';

import { progressPct } from './ai-progress';

describe('AI research progress', () => {
  it('treats the list endpoint terminal status as final status', () => {
    expect(progressPct({ status: 'succeeded', finalStatus: null, currentStep: null })).toBe(100);
    expect(progressPct({ status: 'failed', finalStatus: null, currentStep: 'search' })).toBe(35);
  });

  it('prefers the explicit detail endpoint final status', () => {
    expect(progressPct({ status: 'running', finalStatus: 'succeeded', currentStep: 'write' })).toBe(100);
  });

  it('keeps partial completion visibly below 100%', () => {
    expect(progressPct({ status: 'partial', finalStatus: null, currentStep: 'write' })).toBe(95);
  });

  it('does not let a stale review snapshot make a partial job look complete', () => {
    expect(progressPct({
      status: 'partial',
      finalStatus: 'partial',
      currentStep: 'write',
      review: { phase: 'reviewing' },
    })).toBe(95);
  });

  it('does not present an in-flight write step as completed', () => {
    expect(progressPct({ status: 'running', finalStatus: null, currentStep: 'write' })).toBe(85);
  });

  it('shows honest incremental progress for deep research branches', () => {
    expect(progressPct({
      status: 'running',
      finalStatus: null,
      currentStep: 'search',
      researchProgress: {
        mode: 'deep',
        totalBranchesCompleted: 4,
        totalBranches: 12,
        state: 'searching',
      },
    })).toBe(38);
  });

  it('does not let a deep branch counter override analysis progress', () => {
    expect(progressPct({
      status: 'running',
      finalStatus: null,
      currentStep: 'analyze',
      researchProgress: {
        mode: 'deep',
        totalBranchesCompleted: 12,
        totalBranches: 12,
        state: 'analyzing',
      },
    })).toBe(70);
  });
});
