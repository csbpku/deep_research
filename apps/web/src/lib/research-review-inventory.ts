import {
  asReviewClaims, claimEvidenceStatus, claimIsFactual, getReviewPublicationGate, reviewClaimId, reviewCoverageStatus,
  type ReviewClaimForDecision, type ReviewDecisionRecord, type ReviewPublicationGate,
} from './research-review-decisions';
import type { ReviewRunState } from './research-review-state';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** claim_verification runs the full reviewer; evidence_challenge only judges
 * the stored target. A local coverage_status=complete never means full text.
 */
export function researchReviewScope(run: ReviewRunState): 'full' | 'claim' {
  const details = record(run.details);
  return [details.reviewMode, details.review_mode, run.triggeredBy].includes('evidence_challenge') ? 'claim' : 'full';
}

export function researchReviewScopeMetadata(run: ReviewRunState) {
  const details = record(run.details);
  return {
    scope: researchReviewScope(run),
    targetClaim: asReviewClaims([details.targetClaim]).at(0) ?? null,
    requestedFromRunId: typeof details.requestedFromRunId === 'string' ? details.requestedFromRunId : null,
  };
}

function completed(run: ReviewRunState | undefined): run is ReviewRunState {
  return Boolean(run && run.executionStatus === 'completed'
    && run.outcome !== 'unavailable' && run.outcome !== 'stale'
    && reviewCoverageStatus(run.summary) !== 'insufficient'
    && !(asReviewClaims(run.claims).length === 0 && (run.outcome === 'attention' || run.outcome === 'insufficient')));
}

export function hasCompletedFullReviewInventory(run: ReviewRunState | undefined): boolean {
  return completed(run) && researchReviewScope(run) === 'full';
}

/** The newest complete full inventory is the replacement boundary. Every
 * newer partial or unfinished run still contributes to the same ledger.
 */
export function researchReviewInventoryRuns(runs: ReviewRunState[] | undefined, revisionHash: string): ReviewRunState[] {
  const result: ReviewRunState[] = [];
  const exact = (runs ?? []).filter((run) => run.revisionHash === revisionHash)
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
  for (const run of exact) {
    result.push(run);
    if (hasCompletedFullReviewInventory(run)) break;
  }
  return result;
}

interface InventoryEntry {
  claim: ReviewClaimForDecision;
  decision?: ReviewDecisionRecord;
  runId: string;
}
const wording = (claim: ReviewClaimForDecision) => claim.claim?.replace(/\s+/gu, ' ').trim() ?? '';
const strength = (claim: ReviewClaimForDecision) => ({ supported: 0, unverified: 1, contradicted: 2 })[claimEvidenceStatus(claim)] * 2
  + Number(claim.risk?.toLowerCase() === 'high');

function claimDecision(run: ReviewRunState, claim: ReviewClaimForDecision) {
  let latest: ReviewDecisionRecord | undefined;
  for (const decision of run.decisions ?? []) {
    if (decision.claimId !== reviewClaimId(claim)) continue;
    if (!latest || new Date(decision.createdAt ?? 0).getTime() >= new Date(latest.createdAt ?? 0).getTime()) latest = decision;
  }
  return latest;
}

export function resolveResearchReviewInventory(input: {
  reviewRuns?: ReviewRunState[];
  revisionHash: string;
  researchSufficiencyStatus: ReviewPublicationGate['researchSufficiencyStatus'];
}) {
  const runs = researchReviewInventoryRuns(input.reviewRuns, input.revisionHash);
  const latest = runs[0];
  const machineIncomplete = !hasCompletedFullReviewInventory(latest);
  const entries = new Map<string, InventoryEntry>();
  const processedRunIds = new Set<string>();
  for (const run of [...runs].reverse()) {
    const scope = researchReviewScopeMetadata(run);
    const partial = scope.scope === 'claim';
    const target = scope.targetClaim;
    const requestedFrom = runs.find((candidate) => candidate.id === scope.requestedFromRunId
      && processedRunIds.has(candidate.id)
      && candidate.executionStatus === 'completed'
      && candidate.outcome !== 'unavailable' && candidate.outcome !== 'stale'
      && candidate.createdAt !== undefined && run.createdAt !== undefined
      && new Date(candidate.createdAt ?? 0).getTime() < new Date(run.createdAt ?? 0).getTime());
    const validTarget = target && requestedFrom && asReviewClaims(requestedFrom.claims).some((claim) => (
      reviewClaimId(claim) === reviewClaimId(target) && wording(claim) === wording(target)
    ));
    for (const claim of asReviewClaims(run.claims)) {
      const key = wording(claim);
      if (!key || !reviewClaimId(claim)) continue;
      // Partial responses can only supersede the exact source run's target.
      // Reused IDs or missing lineage cannot withdraw unrelated findings.
      const matchesTarget = target && reviewClaimId(claim) === reviewClaimId(target) && key === wording(target);
      if (partial && !matchesTarget && claimEvidenceStatus(claim) === 'supported') continue;
      const previous = entries.get(key);
      const candidate = { claim, decision: claimDecision(run, claim), runId: run.id };
      const settledTargetSupport = partial && matchesTarget && completed(run) && validTarget
        && previous && reviewClaimId(previous.claim) === reviewClaimId(target)
        && claimEvidenceStatus(claim) === 'supported';
      if (settledTargetSupport || !previous || strength(claim) > strength(previous.claim)) {
        entries.set(key, candidate);
      } else if (strength(claim) === strength(previous.claim) && candidate.decision && !previous.decision) {
        entries.set(key, { ...previous, decision: candidate.decision });
      }
    }
    processedRunIds.add(run.id);
  }
  const inventory = [...entries.values()];
  // A malformed/legacy blocked outcome with no addressable high-risk claim
  // is still a warning. A one-claim retry cannot silently explain it away.
  // Addressable blockers instead follow their exact claim, so a valid local
  // supporting result can withdraw that target without a sticky old verdict.
  const unexplainedBlocker = runs.some((run) => run.outcome === 'blocked' && !asReviewClaims(run.claims).some((claim) => (
    claimIsFactual(claim) && claimEvidenceStatus(claim) === 'contradicted' && claim.risk?.toLowerCase() === 'high'
      && reviewClaimId(claim) && wording(claim)
  )));
  // IDs are local to runs. Namespace the aggregate gate ledger so a decision
  // on an identically named ID in another run cannot resolve a different fact.
  const claims = inventory.map((entry, index) => ({ ...entry.claim, claim_id: `inventory-${index}` }));
  const decisions = inventory.flatMap((entry, index) => entry.decision ? [{ ...entry.decision, claimId: `inventory-${index}` }] : []);
  const gate = latest ? getReviewPublicationGate({
    executionStatus: 'completed',
    outcome: unexplainedBlocker ? 'blocked' : hasCompletedFullReviewInventory(latest) ? latest.outcome : 'clear',
    coverageStatus: machineIncomplete ? 'insufficient' : reviewCoverageStatus(latest.summary),
    researchSufficiencyStatus: input.researchSufficiencyStatus, claims, decisions,
  }) : null;
  return { runs, latest, inventory, gate, machineIncomplete };
}
