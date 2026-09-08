import { describe, expect, it } from 'vitest';

import { isEvidenceFreeOutput, taskStatusBadgeValue, taskStatusLabel } from './ai-research-task-status';

describe('AI research task status semantics', () => {
  it('does not call a model-only brief a completed research result', () => {
    const item = {
      status: 'succeeded',
      reportType: 'summary_brief',
      hasReport: true,
      deliverableStatus: 'report' as const,
      capturedSourcesCount: 0,
    };

    expect(isEvidenceFreeOutput(item)).toBe(true);
    expect(taskStatusBadgeValue(item)).toBe('partial');
    expect(taskStatusLabel(item)).toBe('仅模型摘录');
  });

  it('keeps an evidence-backed Slides output completed', () => {
    const item = {
      status: 'succeeded',
      reportType: 'slides',
      hasReport: true,
      deliverableStatus: 'report' as const,
      capturedSourcesCount: 7,
    };

    expect(isEvidenceFreeOutput(item)).toBe(false);
    expect(taskStatusBadgeValue(item)).toBe('succeeded');
    expect(taskStatusLabel(item)).toBe('需要确认');
  });

  it('does not infer evidence quality when the legacy field is absent', () => {
    const item = { status: 'succeeded', reportType: 'research_report', hasReport: true };
    expect(isEvidenceFreeOutput(item)).toBe(false);
    expect(taskStatusLabel(item)).toBe('需要确认');
  });

  it('keeps an unavailable audit separate from a failed research task', () => {
    const item = {
      status: 'succeeded',
      reportType: 'web_brief',
      hasReport: true,
      deliverableStatus: 'report' as const,
      capturedSourcesCount: 1,
      reviewStatus: 'review_unavailable',
    };

    expect(taskStatusBadgeValue(item)).toBe('partial');
    expect(taskStatusLabel(item)).toBe('暂时无法确认');
  });

  it('keeps a queued audit separate from research execution', () => {
    const item = {
      status: 'succeeded',
      reportType: 'research_report',
      hasReport: true,
      deliverableStatus: 'report' as const,
      capturedSourcesCount: 4,
      reviewStatus: 'queued',
    };

    expect(taskStatusBadgeValue(item)).toBe('partial');
    expect(taskStatusLabel(item)).toBe('结果整理中');
  });

  it('surfaces a blocked audit as a publish gate', () => {
    const item = {
      status: 'succeeded',
      reportType: 'research_report',
      hasReport: true,
      deliverableStatus: 'report' as const,
      reviewStatus: 'blocked',
    };

    expect(taskStatusBadgeValue(item)).toBe('failed');
    expect(taskStatusLabel(item)).toBe('需要修改');
  });
});
