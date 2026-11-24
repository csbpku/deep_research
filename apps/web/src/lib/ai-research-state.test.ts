import { describe, expect, it } from 'vitest';
import { defaultReportTypeForBrief, isResearchReportType } from './ai-research-state';

describe('persisted report types', () => {
  it.each(['decision_memo', 'comparison_matrix', 'learning_path', 'research_report', 'summary_brief', 'slides', 'web_brief'])(
    'accepts the shared schema value %s', value => expect(isResearchReportType(value)).toBe(true),
  );
  it.each([undefined, null, '', 'unknown', {}, ['learning_path']])('rejects an absent or malformed value %s', value => {
    expect(isResearchReportType(value)).toBe(false);
  });
});

describe('defaultReportTypeForBrief', () => {
  it('keeps a plain decision on the memo', () => {
    expect(defaultReportTypeForBrief({ objective: 'decide' })).toBe('decision_memo');
  });
  it('puts a comparison-only plan on the matrix', () => {
    expect(defaultReportTypeForBrief({ objective: 'decide', comparisonOnly: true })).toBe('comparison_matrix');
  });
  it('puts a learning plan on the learning path', () => {
    expect(defaultReportTypeForBrief({ objective: 'learn' })).toBe('learning_path');
  });
  it('falls back to a report when the intent is unknown', () => {
    expect(defaultReportTypeForBrief({ objective: 'explore' })).toBe('research_report');
    expect(defaultReportTypeForBrief(null)).toBe('research_report');
  });
});
