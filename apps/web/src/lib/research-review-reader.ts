import {
  claimEvidenceStatus, claimIsFactual, getReviewDisclosureItems, reviewClaimId,
  type ReviewClaimEvidenceStatus, type ReviewPublicationGate,
} from './research-review-decisions';
import { hasCompletedFullReviewInventory, researchReviewScope, resolveResearchReviewInventory } from './research-review-inventory';
import type { CurrentReviewState, ReviewRunState } from './research-review-state';

export type ResearchReviewVerification = 'verified' | 'disclosed' | 'conflicted' | 'unverified' | null;
export interface ResearchReviewReaderItem {
  claimId: string;
  claim: string;
  risk?: string | null;
  action?: 'accept_uncertainty';
  label: string;
  reason?: string | null;
  evidenceStatus: ReviewClaimEvidenceStatus;
}
export interface ResearchReviewReaderSummary {
  coverageStatus: ReviewPublicationGate['coverageStatus'];
  researchSufficiencyStatus: ReviewPublicationGate['researchSufficiencyStatus'];
  openCount: number;
  unsupportedCount: number;
  conflictCount: number;
  highRiskOpenCount: number;
  hardBlockCount?: number;
  hasBlockingConflict?: boolean;
  disclosedCount: number;
  machineIncomplete: boolean;
  reviewStatus?: string;
  reviewScope?: 'full' | 'claim' | null;
  retainedPreviousRisks?: boolean;
}
export interface ResearchReviewReaderProjection {
  reviewVerification: ResearchReviewVerification;
  reviewDisclosure: ResearchReviewReaderItem[];
  reviewDisclosureSummary: ResearchReviewReaderSummary | null;
}

export const hasCompletedReviewInventory = hasCompletedFullReviewInventory;

/** Reader risks are facts about the revision, not permission to publish it.
 * An unfinished retry cannot erase an earlier finding on the same text.
 * Only a completed replacement inventory supersedes that earlier inventory.
 */
export function projectResearchReviewForReader(input: {
  status: string;
  creationMethod: string;
  currentReview: CurrentReviewState;
  reviewRuns?: ReviewRunState[];
  researchSufficiencyStatus: ReviewPublicationGate['researchSufficiencyStatus'];
}): ResearchReviewReaderProjection {
  const empty = { reviewVerification: null, reviewDisclosure: [], reviewDisclosureSummary: null };
  if (input.status === 'draft' || input.creationMethod !== 'ai_research') return empty;
  const { runs, latest, inventory, gate, machineIncomplete } = resolveResearchReviewInventory({
    reviewRuns: input.reviewRuns, revisionHash: input.currentReview.revisionHash,
    researchSufficiencyStatus: input.researchSufficiencyStatus,
  });
  const reviewDisclosure: ResearchReviewReaderItem[] = inventory.flatMap(({ claim, decision }) => {
    const claimId = reviewClaimId(claim);
    if (!claimId || !claimIsFactual(claim) || claimEvidenceStatus(claim) === 'supported') return [];
    const exception = getReviewDisclosureItems({ claims: [claim], decisions: decision ? [decision] : [] }).at(0);
    const evidenceStatus = claimEvidenceStatus(claim);
    return [{
      claimId, claim: claim.claim?.trim() || '未命名声明', risk: claim.risk ?? null,
      evidenceStatus, label: evidenceStatus === 'contradicted' ? '来源存在冲突' : '未经核验', ...exception,
    }];
  });
  if (!machineIncomplete && latest?.outcome === 'clear' && gate?.status === 'clear') {
    return { ...empty, reviewVerification: 'verified' };
  }
  const conflictCount = reviewDisclosure.filter((item) => item.evidenceStatus === 'contradicted').length;
  const hardBlockCount = reviewDisclosure.filter((item) => item.evidenceStatus === 'contradicted' && item.risk?.toLowerCase() === 'high').length;
  const disclosedCount = reviewDisclosure.filter((item) => item.action === 'accept_uncertainty').length;
  return {
    reviewVerification: hardBlockCount > 0 || gate?.status === 'blocked' ? 'conflicted'
      : machineIncomplete ? 'unverified' : 'disclosed',
    reviewDisclosure,
    reviewDisclosureSummary: {
      coverageStatus: gate?.coverageStatus ?? null,
      researchSufficiencyStatus: input.researchSufficiencyStatus,
      openCount: reviewDisclosure.length - disclosedCount,
      unsupportedCount: reviewDisclosure.length - conflictCount,
      conflictCount, hardBlockCount,
      hasBlockingConflict: gate?.status === 'blocked',
      highRiskOpenCount: reviewDisclosure.filter((item) => item.risk?.toLowerCase() === 'high').length,
      disclosedCount, machineIncomplete,
      reviewStatus: input.currentReview.status,
      reviewScope: latest ? researchReviewScope(latest) : null,
      retainedPreviousRisks: machineIncomplete && runs.length > 1 && reviewDisclosure.length > 0,
    },
  };
}

/** Shared by the page and downloadable artifact so neither loses a caveat. */
export function researchReviewDisclosureMessages(summary: ResearchReviewReaderSummary): string[] {
  const messages: string[] = [];
  if ((summary.hardBlockCount ?? 0) > 0 || summary.hasBlockingConflict || summary.reviewStatus === 'blocked') {
    messages.push('核验发现高风险来源冲突，相关结论需要修订。');
  }
  if (summary.reviewScope === 'claim') messages.push('最新一轮只核验了指定声明，不能视为全文核验。');
  else if (summary.machineIncomplete) messages.push('最新自动核验尚未完成或未完整覆盖报告。');
  if (summary.retainedPreviousRisks) messages.push('已保留此前同版本的风险警示；未完成的重新核验不会消除这些风险。');
  if (summary.openCount > 0) {
    messages.push(`当前仍有 ${summary.openCount} 条声明未完成核验${summary.conflictCount > 0 ? `，其中 ${summary.conflictCount} 条存在来源冲突` : ''}。`);
  }
  if (summary.researchSufficiencyStatus === 'insufficient') messages.push('研究资料尚未覆盖原问题的全部关键部分。');
  if (summary.disclosedCount > 0) messages.push(`作者已明确接受 ${summary.disclosedCount} 条不确定性。`);
  return messages;
}
