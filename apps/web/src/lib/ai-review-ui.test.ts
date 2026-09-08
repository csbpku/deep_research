import { describe, expect, it } from 'vitest';
import {
  claimDisplayStatus,
  countClaimDisplayStatuses,
  reviewDisplayLabel,
  reviewDisplayStatus,
  reviewProgress,
  reviewDisplayTone,
  reviewBatchProgress,
  reviewUnavailableReason,
} from './ai-review-ui';

describe('AI review UI state', () => {
  it('keeps review separate from the generator status', () => {
    expect(reviewDisplayStatus({ phase: 'reviewing' })).toBe('reviewing');
    expect(reviewDisplayLabel({ phase: 'reviewing' })).toBe('结果整理中');
    expect(reviewProgress('reviewing')).toBe(90);
  });

  it('explains a queued review without presenting it as a failed report', () => {
    expect(reviewDisplayStatus({ phase: 'queued', status: 'queued' })).toBe('queued');
    expect(reviewDisplayLabel({ phase: 'queued', status: 'queued' })).toBe('结果整理中');
    expect(reviewDisplayTone({ status: 'queued' })).toBe('warning');
    expect(reviewProgress('queued')).toBeNull();
  });

  it('renders blocked as a publish gate, not success', () => {
    expect(reviewDisplayStatus({ phase: 'completed', status: 'blocked' })).toBe('blocked');
    expect(reviewDisplayLabel({ phase: 'completed', status: 'blocked' })).toBe('需要修改');
    expect(reviewProgress('completed')).toBe(100);
  });

  it('keeps evidence gaps distinct from factual conflicts', () => {
    expect(reviewDisplayLabel({ phase: 'completed', status: 'needs_action' })).toBe('需要处理');
    expect(reviewDisplayTone({ status: 'needs_action' })).toBe('warning');
  });

  it('does not claim an unavailable review passed', () => {
    expect(reviewDisplayLabel({ phase: 'completed', status: 'review_unavailable' })).toBe('暂时无法确认');
    expect(reviewDisplayTone({ status: 'review_unavailable' })).toBe('warning');
    expect(reviewUnavailableReason({ status: 'review_unavailable', error_code: 'timeout' })).toContain('超时');
    expect(reviewUnavailableReason({ status: 'review_unavailable', error: 'ValueError' })).toContain('无法解析');
    expect(reviewDisplayLabel(null)).toBe('等待审核');
    expect(reviewProgress('not_started')).toBeNull();
  });

  it('reads batch progress as operational coverage, not a verdict', () => {
    expect(reviewBatchProgress({
      adjudicating: {
        batch_index: 2,
        batch_count: 4,
        completed_batch_count: 1,
        failed_batch_count: 1,
        judged_claim_count: 6,
        total_claim_count: 12,
        batch_status: 'failed',
      },
    })).toEqual({
      batchIndex: 2,
      batchCount: 4,
      completedBatchCount: 1,
      failedBatchCount: 1,
      judgedClaimCount: 6,
      totalClaimCount: 12,
      status: 'failed',
    });
    expect(reviewBatchProgress({ phase: 'inventorying' })).toBeNull();
  });

  it('labels non-research reports as not applicable', () => {
    expect(reviewDisplayLabel({ status: 'not_applicable' })).toBe('不适用');
  });

  it('only presents a supported claim when an inspectable excerpt exists', () => {
    expect(claimDisplayStatus({ verdict: 'verified', evidence: { excerpt: '原文明确写出该事实。' } })).toBe('supported');
    expect(claimDisplayStatus({ verdict: 'verified', evidence: { excerpt: '' } })).toBe('unverified');
    expect(claimDisplayStatus({ verdict: 'supported', evidence: null })).toBe('unverified');
    expect(claimDisplayStatus({ verdict: 'conflict', evidence: null })).toBe('contradicted');
  });

  it('keeps ledger counts aligned with the conservative single-claim label', () => {
    expect(countClaimDisplayStatuses([
      { verdict: 'pass', evidence: { excerpt: '可核对摘录' } },
      { verdict: 'verified', evidence: { excerpt: null } },
      { verdict: 'contradicted' },
      { risk: 'opinion', verdict: 'unverified' },
    ])).toEqual({ supported: 1, unverified: 1, contradicted: 1 });
  });

  it('does not turn not-applicable dispositions into fact-review work', () => {
    expect(countClaimDisplayStatuses([
      { risk: 'medium', verdict: 'not_applicable' },
    ])).toEqual({ supported: 0, unverified: 0, contradicted: 0 });
  });

  it('does not count research-process observations as unsupported facts', () => {
    expect(countClaimDisplayStatuses([
      {
        claim: '本轮仅抓取到目录页，未抓取到安装正文',
        claim_type: 'research_process',
        risk: 'medium',
        verdict: 'unverified',
      },
    ])).toEqual({ supported: 0, unverified: 0, contradicted: 0 });
  });
});
