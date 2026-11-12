import { createHash } from 'node:crypto';
import { hashResearchRevision, type ResearchRevisionFields } from './research-revision';
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
  const run = (input.reviewRuns ?? [])
    .filter((candidate) => candidate.revisionHash === revisionHash)
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
  const snapshot = {
    revisionHash, reviewStatus: input.reviewStatus ?? null, researchSufficiencyStatus,
    run: run ? {
      id: run.id, executionStatus: run.executionStatus, outcome: run.outcome,
      attempt: run.attempt, summary: run.summary ?? null, claims: run.claims ?? [],
      decisions: [...(run.decisions ?? [])].map((decision) => ({
        id: decision.id ?? null, claimId: decision.claimId, action: decision.action,
        reason: decision.reason ?? null, createdAt: decision.createdAt ? new Date(decision.createdAt).toISOString() : null,
      })).sort((a, b) => `${a.createdAt}:${a.id}`.localeCompare(`${b.createdAt}:${b.id}`)),
    } : null,
  };
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
