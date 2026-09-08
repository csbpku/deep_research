/**
 * The machine's claim verdict and the author's publication decision are
 * deliberately different things.
 *
 * A reviewer can only say what the captured material supports. It cannot
 * decide whether an author is willing to publish a low-risk open question.
 * This module is shared by the BFF and the UI so that the publish gate and
 * the visible work queue never disagree about the same claim.
 */

export type ReviewDecisionAction =
  | 'confirm_support'
  | 'accept_uncertainty'
  /** Workflow event: the author disputes the machine's support relationship. */
  | 'challenge_support'
  /** @deprecated Kept for audit compatibility; new runs may not resolve a conflict this way. */
  | 'accept_conflict_risk'
  /** @deprecated Kept for audit compatibility; reclassifying requires editing the wording. */
  | 'mark_not_fact'
  | 'request_verification';

export interface ReviewClaimForDecision {
  claim_id?: string;
  claim?: string;
  claim_type?: 'external_fact' | 'research_process' | 'interpretation' | 'citation_relationship' | string;
  risk?: string;
  verdict?: string;
  judgment_status?: 'settled' | 'not_judged' | 'execution_failed' | 'disputed' | string | null;
  execution_error_code?: string | null;
  reason?: string | null;
  location?: [number, number] | { start: number; end: number } | null;
  evidence?: {
    source_url?: string | null;
    excerpt?: string | null;
    observed_at?: string | null;
    resolver?: string | null;
  } | null;
}

export interface ReviewDecisionRecord {
  id?: string;
  claimId: string;
  action: ReviewDecisionAction | string;
  reason?: string | null;
  metadata?: unknown;
  actorId?: string | null;
  createdAt?: Date | string;
}

export interface ReviewDisclosureItem {
  claimId: string;
  claim: string;
  action: 'accept_uncertainty';
  label: string;
  reason: string | null;
  evidenceStatus: ReviewClaimEvidenceStatus;
}

export type ReviewPublicationGateStatus =
  | 'clear'
  | 'publish_with_disclosure'
  | 'needs_action'
  | 'coverage_insufficient'
  | 'research_insufficient'
  | 'blocked'
  | 'unavailable';

export type ReviewCoverageStatus = 'complete' | 'insufficient' | 'not_applicable';

export interface ReviewPublicationGate {
  status: ReviewPublicationGateStatus;
  /** Whether the reviewer inspected enough of the report to make claim-level decisions. */
  coverageStatus: ReviewCoverageStatus | null;
  coverageIncomplete: boolean;
  /** Whether the research itself covered the confirmed research contract. */
  researchSufficiencyStatus: 'sufficient' | 'insufficient' | 'not_assessed' | null;
  openCount: number;
  highRiskOpenCount: number;
  conflictCount: number;
  acceptedCount: number;
  unsupportedCount: number;
  /** Claims that can be published only because the author accepted uncertainty. */
  disclosedCount: number;
  /** A high-risk conflict is never dismissible by an author decision. */
  hardBlockCount: number;
}

export interface ReviewGateRunInput {
  executionStatus?: string | null;
  outcome?: string | null;
  coverageStatus?: string | null;
  researchSufficiencyStatus?: string | null;
  claims?: unknown;
  decisions?: ReviewDecisionRecord[] | null;
}

const RESOLVING_ACTIONS = new Set<ReviewDecisionAction>([
  'confirm_support',
  'accept_uncertainty',
  'accept_conflict_risk',
  'mark_not_fact',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function asReviewClaims(value: unknown): ReviewClaimForDecision[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((claim) => ({
    claim_id: typeof claim.claim_id === 'string' ? claim.claim_id : undefined,
    claim: typeof claim.claim === 'string' ? claim.claim : undefined,
    claim_type: typeof claim.claim_type === 'string' ? claim.claim_type : undefined,
    risk: typeof claim.risk === 'string' ? claim.risk : undefined,
    verdict: typeof claim.verdict === 'string' ? claim.verdict : undefined,
    judgment_status: typeof claim.judgment_status === 'string' ? claim.judgment_status : null,
    execution_error_code: typeof claim.execution_error_code === 'string' ? claim.execution_error_code : null,
    reason: typeof claim.reason === 'string' ? claim.reason : null,
    location: parseClaimLocation(claim.location),
    evidence: isRecord(claim.evidence)
      ? {
          source_url: typeof claim.evidence.source_url === 'string' ? claim.evidence.source_url : null,
          excerpt: typeof claim.evidence.excerpt === 'string' ? claim.evidence.excerpt : null,
          observed_at: typeof claim.evidence.observed_at === 'string' ? claim.evidence.observed_at : null,
          resolver: typeof claim.evidence.resolver === 'string' ? claim.evidence.resolver : null,
        }
      : null,
  }));
}

function parseClaimLocation(value: unknown): ReviewClaimForDecision['location'] {
  if (Array.isArray(value) && value.length === 2
    && typeof value[0] === 'number' && typeof value[1] === 'number'
    && value[0] >= 0 && value[1] >= value[0]) {
    return [value[0], value[1]];
  }
  if (isRecord(value)
    && typeof value.start === 'number'
    && typeof value.end === 'number'
    && value.start >= 0
    && value.end >= value.start) {
    return { start: value.start, end: value.end };
  }
  return null;
}

export function reviewClaimLocation(claim: ReviewClaimForDecision): [number, number] | null {
  if (Array.isArray(claim.location)
    && claim.location.length === 2
    && claim.location[0] >= 0
    && claim.location[1] >= claim.location[0]) {
    return claim.location;
  }
  const location = claim.location;
  if (isRecord(location)
    && typeof location.start === 'number'
    && typeof location.end === 'number'
    && location.start >= 0
    && location.end >= location.start) {
    return [location.start, location.end];
  }
  return null;
}

/** Keep this ID exactly aligned with the worker's claim_id contract. */
export function reviewClaimId(claim: ReviewClaimForDecision): string | null {
  const value = claim.claim_id?.trim();
  return value ? value : null;
}

export function claimIsCitationRelationship(claim: ReviewClaimForDecision): boolean {
  return claim.claim_type === 'citation_relationship'
    || claim.evidence?.resolver === 'captured-source-citation';
}

/**
 * These statements describe the research run itself rather than the outside
 * world: for example, which pages were captured or which section was missing.
 * They are backed by the persisted research ledger, not by a web quotation,
 * so they must never become human fact-review work items. The text fallback
 * keeps legacy runs safe until they are re-reviewed with `claim_type`.
 */
export function claimIsResearchProcessObservation(claim: {
  claim_type?: string | null;
  claim?: string | null;
}): boolean {
  if (claim.claim_type === 'research_process') return true;
  const text = (claim.claim ?? '').replace(/\s+/gu, ' ');
  return /(?:本轮|本次|当前)(?:研究|检索|搜索|抓取|资料|来源|证据|审核)|(?:没有|未|仅|只)(?:抓取|检索|保存|获取).{0,48}(?:正文|来源|资料|证据|页面)|(?:本轮|本次|当前).{0,16}(?:仅|只|没有|未)(?:抓取|检索|保存|获取)|抓取到的.{0,120}(?:页面|正文).{0,80}(?:未|没有|并未).{0,48}(?:正文|安装|说明|内容)|(?:来源|证据)(?:包|清单|账本).{0,24}(?:本轮|当前)/iu.test(text);
}

export function claimIsFactual(claim: ReviewClaimForDecision): boolean {
  return claim.claim_type !== 'interpretation'
    && !claimIsResearchProcessObservation(claim)
    && claim.risk?.toLowerCase() !== 'opinion'
    && claim.verdict?.toLowerCase() !== 'not_applicable'
    && !claimIsCitationRelationship(claim);
}

export type ReviewClaimEvidenceStatus = 'supported' | 'unverified' | 'contradicted';

export function claimEvidenceStatus(claim: ReviewClaimForDecision): ReviewClaimEvidenceStatus {
  // A raw verdict is not usable until the judging step settled. This keeps a
  // timeout, partial batch, or second-opinion disagreement out of both the
  // publish gate and the reader-facing "conflict" state.
  if (
    claim.judgment_status === 'not_judged'
    || claim.judgment_status === 'execution_failed'
    || claim.judgment_status === 'disputed'
  ) return 'unverified';
  const verdict = claim.verdict?.toLowerCase();
  // "correctable" means an authoritative resolver found a different value
  // (for example a current GitHub star count). It is not an evidence gap
  // that an author may accept as uncertainty; the current wording needs
  // correction before publication.
  if (verdict === 'contradicted' || verdict === 'conflict' || verdict === 'correctable') return 'contradicted';
  if (
    (verdict === 'supported' || verdict === 'verified' || verdict === 'pass')
    && claim.evidence?.excerpt?.trim()
  ) {
    return 'supported';
  }
  return 'unverified';
}

/**
 * Return the one next step that follows from the evidence state.  The UI may
 * offer secondary navigation (open source/edit), but it should not present
 * every possible operation as if the user has to understand the state
 * machine first.
 */
export type ReviewClaimNextAction =
  | 'challenge_support'
  | 'reverify_current_sources'
  | 'find_more_evidence'
  | 'edit_claim'
  | 'none';

export function reviewClaimNextAction(claim: ReviewClaimForDecision): ReviewClaimNextAction {
  if (!claimIsFactual(claim)) return 'none';
  const status = claimEvidenceStatus(claim);
  if (status === 'supported') return 'challenge_support';
  if (status === 'contradicted') return 'edit_claim';
  if (claim.evidence?.source_url || claim.evidence?.excerpt) return 'reverify_current_sources';
  return 'find_more_evidence';
}

/**
 * Read-only projection helper for legacy runs whose reviewer did not persist
 * an excerpt. This never changes the verdict or publication gate; it only
 * lets the UI choose "reverify current sources" when the saved ledger
 * visibly contains the claim's distinctive anchors.
 */
export function claimHasCapturedSourceMatch(
  claim: ReviewClaimForDecision,
  sources: Array<{ title?: string | null; snippet?: string | null }>,
): boolean {
  if (!claimIsFactual(claim) || claim.evidence?.excerpt?.trim()) return false;
  const text = (claim.claim ?? '').toLocaleLowerCase();
  const normalizedClaim = text.replace(/[^\p{L}\p{N}]+/gu, '');
  const tokens = text.match(/[a-z][a-z0-9+#._-]{2,}|[\u4e00-\u9fff]{2,}/giu) ?? [];
  const terms = [...new Set(tokens.map((token) => token.toLocaleLowerCase()))]
    .filter((token) => !new Set(['这条', '该条', '声明', '报告', '内容', '说明', '提及', '支持', '项目', '系统', 'the', 'this', 'claim', 'report']).has(token));
  if (terms.length === 0) return false;

  return sources.some((source) => {
    const sourceText = `${source.title ?? ''} ${source.snippet ?? ''}`.toLocaleLowerCase();
    if (!sourceText.trim()) return false;
    const normalizedSource = sourceText.replace(/[^\p{L}\p{N}]+/gu, '');
    if (normalizedClaim.length >= 16 && normalizedSource.includes(normalizedClaim)) return true;
    const asciiTerms = terms.filter((term) => /^[a-z0-9+#._-]+$/iu.test(term));
    const asciiHits = asciiTerms.filter((term) => sourceText.includes(term)).length;
    const hits = terms.filter((term) => sourceText.includes(term)).length;
    return asciiHits >= 2 && hits / terms.length >= 0.55;
  });
}

function latestDecisions(decisions: ReviewDecisionRecord[] | null | undefined): Map<string, ReviewDecisionRecord> {
  const latest = new Map<string, ReviewDecisionRecord>();
  for (const decision of decisions ?? []) {
    if (!decision.claimId) continue;
    const previous = latest.get(decision.claimId);
    const previousTime = previous?.createdAt ? new Date(previous.createdAt).getTime() : -Infinity;
    const currentTime = decision.createdAt ? new Date(decision.createdAt).getTime() : 0;
    if (!previous || currentTime >= previousTime) latest.set(decision.claimId, decision);
  }
  return latest;
}

/**
 * A publication disclosure is the reader-facing projection of an explicit
 * author decision. Keep it derived from the immutable run rather than from a
 * mutable research field, so the published artifact cannot silently lose the
 * context that made a low/medium-risk evidence gap publishable.
 *
 * A source contradiction is deliberately not a publishable exception. If the
 * author wants to retain a disagreement, the body must say so explicitly and
 * the new wording must go through a new review run. A disclosure attached to
 * an unchanged factual sentence would not make that sentence less misleading.
 */
export function getReviewDisclosureItems(input: {
  claims?: unknown;
  decisions?: ReviewDecisionRecord[] | null;
}): ReviewDisclosureItem[] {
  const claims = asReviewClaims(input.claims);
  const latest = latestDecisions(input.decisions);
  return claims.flatMap((claim) => {
    const claimId = reviewClaimId(claim);
    if (!claimId || !claimIsFactual(claim)) return [];
    const decision = latest.get(claimId);
    if (
      !decision
      || decision.action !== 'accept_uncertainty'
      || !decisionResolvesClaim(claim, decision)
    ) {
      return [];
    }
    return [{
      claimId,
      claim: (claim.claim ?? '未命名声明').trim().slice(0, 1_200),
      action: decision.action,
      label: decisionLabel(decision.action),
      reason: decision.reason?.trim() || null,
      evidenceStatus: claimEvidenceStatus(claim),
    }];
  });
}

/** Read the reviewer coverage marker from a persisted summary without trusting arbitrary JSON. */
export function reviewCoverageStatus(value: unknown): ReviewCoverageStatus | null {
  if (!isRecord(value) || typeof value.coverage_status !== 'string') return null;
  return value.coverage_status === 'complete'
    || value.coverage_status === 'insufficient'
    || value.coverage_status === 'not_applicable'
    ? value.coverage_status
    : null;
}

export function decisionResolvesClaim(
  claim: ReviewClaimForDecision,
  decision: ReviewDecisionRecord | undefined,
): boolean {
  if (!claimIsFactual(claim)) return true;
  const status = claimEvidenceStatus(claim);
  // A machine-supported claim already has an inspectable excerpt. Requiring
  // the author to click a second confirmation would turn a successful
  // evidence match into a phantom human TODO and make the publish gate
  // disagree with the visible claim list.
  if (status === 'supported') return true;
  if (!decision || !RESOLVING_ACTIONS.has(decision.action as ReviewDecisionAction)) return false;
  const risk = claim.risk?.toLowerCase();
  if (decision.action === 'confirm_support') return false;
  if (decision.action === 'accept_uncertainty') {
    return status === 'unverified' && risk !== 'high';
  }
  if (decision.action === 'accept_conflict_risk') {
    // A contradiction is a content problem, not an author preference. The
    // old action remains readable for historical audit rows, but it can never
    // clear a current publication gate.
    return false;
  }
  if (decision.action === 'mark_not_fact') {
    // Reclassifying a factual-looking sentence without changing its wording
    // would let a user bypass the review boundary. Only a machine-labelled
    // non-fact can be treated as such; those claims are not in the pending
    // factual queue in the first place.
    return !claimIsFactual(claim);
  }
  return false;
}

export function decisionLabel(action: string | undefined): string {
  switch (action) {
    case 'confirm_support': return '已确认证据';
    case 'accept_uncertainty': return '已接受待验证项';
    case 'challenge_support': return '已质疑证据关系';
    case 'accept_conflict_risk': return '历史上记录为接受冲突风险';
    case 'mark_not_fact': return '已标为非事实';
    case 'request_verification': return '已请求补充核验';
    default: return '已处理';
  }
}

export function getReviewPublicationGate(input: ReviewGateRunInput): ReviewPublicationGate {
  const coverageStatus = input.coverageStatus === 'complete'
    || input.coverageStatus === 'insufficient'
    || input.coverageStatus === 'not_applicable'
    ? input.coverageStatus
    : input.outcome === 'insufficient'
      ? 'insufficient'
      : null;
  if (input.executionStatus === 'unavailable' || input.outcome === 'unavailable') {
    return {
      status: 'unavailable',
      coverageStatus,
      coverageIncomplete: coverageStatus === 'insufficient',
      researchSufficiencyStatus: normalizeResearchSufficiency(input.researchSufficiencyStatus),
      openCount: 0,
      highRiskOpenCount: 0,
      conflictCount: 0,
      acceptedCount: 0,
      unsupportedCount: 0,
      disclosedCount: 0,
      hardBlockCount: 0,
    };
  }
  if (input.executionStatus !== 'completed') {
    return {
      status: 'needs_action',
      coverageStatus,
      coverageIncomplete: coverageStatus === 'insufficient',
      researchSufficiencyStatus: normalizeResearchSufficiency(input.researchSufficiencyStatus),
      openCount: 0,
      highRiskOpenCount: 0,
      conflictCount: 0,
      acceptedCount: 0,
      unsupportedCount: 0,
      disclosedCount: 0,
      hardBlockCount: 0,
    };
  }

  const claims = asReviewClaims(input.claims);
  const latest = latestDecisions(input.decisions);
  let openCount = 0;
  let highRiskOpenCount = 0;
  let conflictCount = 0;
  let acceptedCount = 0;
  let unsupportedCount = 0;
  let disclosedCount = 0;
  let hardBlockCount = 0;

  for (const claim of claims) {
    if (!claimIsFactual(claim)) continue;
    const status = claimEvidenceStatus(claim);
    const risk = claim.risk?.toLowerCase();
    const decision = latest.get(reviewClaimId(claim) ?? '');
    const resolved = decisionResolvesClaim(claim, decision);
    if (status === 'contradicted' && claim.judgment_status !== 'disputed') conflictCount += 1;
    if (status === 'unverified') unsupportedCount += 1;
    if (resolved) {
      acceptedCount += 1;
      continue;
    }
    openCount += 1;
    if (risk === 'high') highRiskOpenCount += 1;
    if (status === 'contradicted' && risk === 'high') {
      hardBlockCount += 1;
    }
  }

  disclosedCount = getReviewDisclosureItems({ claims, decisions: input.decisions }).length;

  if (hardBlockCount > 0 || input.outcome === 'blocked') {
    return {
      status: 'blocked',
      coverageStatus,
      coverageIncomplete: coverageStatus === 'insufficient',
      researchSufficiencyStatus: normalizeResearchSufficiency(input.researchSufficiencyStatus),
      openCount,
      highRiskOpenCount,
      conflictCount,
      acceptedCount,
      unsupportedCount,
      disclosedCount,
      hardBlockCount,
    };
  }
  // A completed run can still be epistemically incomplete: for example, the
  // reviewer may have returned one valid claim from a long report. A person
  // cannot resolve an inventory that was never produced, so no claim-level
  // decision may clear this gate. This is a review coverage problem, not a
  // verdict that the report contains false facts.
  if (coverageStatus === 'insufficient') {
    return {
      status: 'coverage_insufficient',
      coverageStatus,
      coverageIncomplete: true,
      researchSufficiencyStatus: normalizeResearchSufficiency(input.researchSufficiencyStatus),
      openCount,
      highRiskOpenCount,
      conflictCount,
      acceptedCount,
      unsupportedCount,
      disclosedCount,
      hardBlockCount,
    };
  }
  const researchSufficiencyStatus = normalizeResearchSufficiency(input.researchSufficiencyStatus);
  if (researchSufficiencyStatus === 'insufficient') {
    return {
      status: 'research_insufficient',
      coverageStatus,
      coverageIncomplete: false,
      researchSufficiencyStatus,
      openCount,
      highRiskOpenCount,
      conflictCount,
      acceptedCount,
      unsupportedCount,
      disclosedCount,
      hardBlockCount,
    };
  }
  // ``attention`` is a machine summary of the original run. Once every
  // actionable claim has an explicit human disposition, it must not keep the
  // document blocked merely because the old run outcome is still attention.
  // An empty/insufficient inventory remains unavailable for publication.
  if (
    openCount > 0
    || (claims.length === 0 && (input.outcome === 'attention' || input.outcome === 'insufficient'))
  ) {
    return {
      status: 'needs_action',
      coverageStatus,
      coverageIncomplete: false,
      researchSufficiencyStatus,
      openCount,
      highRiskOpenCount,
      conflictCount,
      acceptedCount,
      unsupportedCount,
      disclosedCount,
      hardBlockCount,
    };
  }
  return {
    status: disclosedCount > 0 ? 'publish_with_disclosure' : 'clear',
    coverageStatus,
    coverageIncomplete: false,
    researchSufficiencyStatus,
    openCount,
    highRiskOpenCount,
    conflictCount,
    acceptedCount,
    unsupportedCount,
    disclosedCount,
    hardBlockCount,
  };
}

function normalizeResearchSufficiency(value: string | null | undefined): ReviewPublicationGate['researchSufficiencyStatus'] {
  return value === 'sufficient' || value === 'insufficient' || value === 'not_assessed'
    ? value
    : null;
}

export function isReviewDecisionAction(value: string): value is ReviewDecisionAction {
  return value === 'confirm_support'
    || value === 'accept_uncertainty'
    || value === 'challenge_support'
    || value === 'accept_conflict_risk'
    || value === 'mark_not_fact'
    || value === 'request_verification';
}
