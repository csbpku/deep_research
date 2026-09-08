import { describe, expect, it } from 'vitest';

import { researchUserStatus } from './research-user-status';

describe('research user status', () => {
  const report = {
    status: 'succeeded',
    reportType: 'research_report',
    hasReport: true,
    capturedSourcesCount: 4,
  };

  it('hides queue and review implementation states behind reader language', () => {
    expect(researchUserStatus({ ...report, reviewStatus: 'reviewing' }).label).toBe('结果整理中');
    expect(researchUserStatus({ ...report, reviewStatus: 'passed' }).label).toBe('可以直接参考');
    expect(researchUserStatus({ ...report, reviewStatus: 'needs_action' }).label).toBe('需要确认');
  });

  it('keeps source coverage and source conflict as different actions', () => {
    expect(researchUserStatus({ ...report, reviewStatus: 'research_insufficient' }).code).toBe('sources_incomplete');
    expect(researchUserStatus({ ...report, reviewStatus: 'blocked' }).code).toBe('needs_revision');
  });

  it('does not call an unavailable check a factual failure', () => {
    const status = researchUserStatus({ ...report, reviewStatus: 'review_unavailable' });
    expect(status.label).toBe('暂时无法确认');
    expect(status.tone).toBe('warning');
    expect(status.description).toContain('不代表结论错误');
  });

  it('keeps evidence-only outputs actionable without exposing review internals', () => {
    const status = researchUserStatus({
      status: 'partial',
      reportType: 'research_report',
      hasReport: false,
      deliverableStatus: 'evidence_only',
      capturedSourcesCount: 3,
    });
    expect(status).toMatchObject({ code: 'materials_only', label: '资料已保留' });
  });
});
