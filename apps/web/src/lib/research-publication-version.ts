import { createHash } from 'node:crypto';
import { hashResearchRevision, type ResearchRevisionFields } from './research-revision';
import { researchReviewInventoryRuns, researchReviewScopeMetadata } from './research-review-inventory';
import type { ReviewRunState } from './research-review-state';

/** Bind confirmation to the document and exact review/decision ledger seen.
 * Normalize the projection so detail GET and transaction reads hash the same
 * fields even though their other selected audit metadata differs.
 */
export function researchPublicationVersion(input: ResearchRevisionFields & {
  reviewStatus?: string | null;
  reviewRuns?: ReviewRunState[];
}, researchSufficiencyStatus: string | null): string {
  const revisionHash = hashResearchRevision(input);
  const runs = researchReviewInventoryRuns(input.reviewRuns, revisionHash);
  const snapshot = {
    revisionHash, reviewStatus: input.reviewStatus ?? null, researchSufficiencyStatus,
    runs: runs.map((run) => ({
      id: run.id, executionStatus: run.executionStatus, outcome: run.outcome,
      ...researchReviewScopeMetadata(run),
      attempt: run.attempt, summary: run.summary ?? null, claims: run.claims ?? [],
      decisions: [...(run.decisions ?? [])].map((decision) => ({
        id: decision.id ?? null, claimId: decision.claimId, action: decision.action,
        reason: decision.reason ?? null, createdAt: decision.createdAt ? new Date(decision.createdAt).toISOString() : null,
      })).sort((a, b) => `${a.createdAt}:${a.id}`.localeCompare(`${b.createdAt}:${b.id}`)),
    })),
  };
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
