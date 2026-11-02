'use client';

import React, { useState } from 'react';
import NextLink from 'next/link';
import { AlertTriangle, Check, RefreshCw } from 'lucide-react';

import { AiResearchButton as Button } from '@/components/ai-research/AiResearchMaterial';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useQueryClient } from '@tanstack/react-query';
import { toApiHttpError } from '@/lib/errors/api-error';
import { friendlyMessage } from '@/lib/errors/friendly';
import {
  claimEvidenceStatus,
  decisionResolvesClaim,
  getReviewPublicationGate,
  reviewClaimId,
  type ReviewDecisionAction,
  type ReviewDecisionRecord,
} from '@/lib/research-review-decisions';

interface ClaimShape {
  claim_id?: string;
  claim?: string;
  claim_type?: string;
  risk?: string;
  verdict?: string;
  judgment_status?: string | null;
  evidence?: { excerpt?: string | null; source_url?: string | null } | null;
}

export interface ReviewClaimRun {
  id?: string;
  executionStatus: string;
  outcome?: string | null;
  summary?: unknown;
  claims?: ClaimShape[] | null;
  decisions?: Array<Pick<ReviewDecisionRecord, 'claimId' | 'action' | 'reason'> & { id?: string }> | null;
  publicationGate?: { status: string; openCount?: number } | null;
}

const STATUS_STYLES: Record<string, { label: string; sx: Record<string, string> }> = {
  supported: { label: '有直接依据', sx: { bgcolor: 'var(--dr-color-success-container)', color: 'success.main' } },
  contradicted: { label: '来源不一致', sx: { bgcolor: 'var(--dr-color-danger-container)', color: 'error.main' } },
  unverified: { label: '还缺直接依据', sx: { bgcolor: 'var(--dr-color-warning-container)', color: 'warning.main' } },
};

/**
 * Per-claim review queue for a finished research run.
 *
 * The machine verdict is immutable; what the author decides here is whether a
 * low-risk open item is acceptable for publication or whether the claim needs
 * to be rewritten. Without this surface a report whose only open items are
 * acceptable uncertainties can never clear the publication gate.
 */
export function ReviewClaimsPanel({
  jobId,
  draftResearchId,
  reviewRun,
}: {
  jobId: string;
  draftResearchId: string | null;
  reviewRun: ReviewClaimRun | null;
}) {
  const queryClient = useQueryClient();
  const [busyClaimId, setBusyClaimId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<{ claimId: string; action: ReviewDecisionAction } | null>(null);
  const [reason, setReason] = useState('');

  if (!reviewRun) return null;
  const stale = reviewRun.executionStatus === 'stale';
  const claims = stale ? [] : (reviewRun.claims ?? []).filter((claim) => (
    claim.claim_type !== 'interpretation' && claim.claim_type !== 'research_process' && claim.claim_type !== 'citation_relationship'
  ));
  const decisions = reviewRun.decisions ?? [];
  const decisionByClaim = new Map<string, { action: string; reason?: string | null }>();
  for (const decision of decisions) {
    if (decision.claimId) decisionByClaim.set(decision.claimId, { action: decision.action, reason: decision.reason });
  }
  const gate = reviewRun.publicationGate ?? getReviewPublicationGate({
    executionStatus: reviewRun.executionStatus,
    outcome: reviewRun.outcome,
    claims: reviewRun.claims ?? [],
    decisions,
  });
  const open = claims.filter((claim) => (
    claimEvidenceStatus(claim) !== 'supported'
    && !decisionResolvesClaim(claim, decisionByClaim.get(reviewClaimId(claim) ?? '') as ReviewDecisionRecord | undefined)
  ));

  async function submitDecision(claim: ClaimShape, action: ReviewDecisionAction, why?: string) {
    const claimId = reviewClaimId(claim);
    if (!claimId || !draftResearchId) return;
    setBusyClaimId(claimId);
    setError(null);
    try {
      const response = await fetch(`/api/researches/${draftResearchId}/review/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: reviewRun?.id,
          claimId,
          action,
          ...(why?.trim() ? { reason: why.trim() } : {}),
        }),
      });
      if (!response.ok) throw await toApiHttpError(response, '保存处理失败');
      setReasonFor(null);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['inline-ai-research', jobId] });
    } catch (err) {
      setError(friendlyMessage(err, '保存处理失败，请稍后重试。'));
    } finally {
      setBusyClaimId(null);
    }
  }

  async function recheck() {
    if (!draftResearchId) return;
    setBusyClaimId('__recheck__');
    setError(null);
    try {
      const response = await fetch(`/api/researches/${draftResearchId}/review`, { method: 'POST' });
      if (!response.ok) throw await toApiHttpError(response, '重新检查失败');
      await queryClient.invalidateQueries({ queryKey: ['inline-ai-research', jobId] });
    } catch (err) {
      setError(friendlyMessage(err, '重新检查失败，请稍后重试。'));
    } finally {
      setBusyClaimId(null);
    }
  }

  return (
    <Box
      component="details"
      sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}
      open={open.length > 0}
    >
      <Box component="summary" sx={{ cursor: 'pointer', typography: 'metadata', fontWeight: 500 }}>
        逐条审核 · {open.length > 0 ? `${open.length} 条待处理` : '没有待处理结论'}
        {gate.status === 'clear' ? ' · 可发布' : gate.status === 'publish_with_disclosure' ? ' · 可发布并保留提示' : ''}
      </Box>
      <Box sx={{ mt: 1.5, display: 'grid', gap: 1.5 }}>
        {stale ? (
          <Typography component="p" variant="metadata" color="warning.main">
            这份报告在审核后被修改过，旧的逐条结论不再适用。重新检查后可以继续处理。
          </Typography>
        ) : claimList()}

        {error ? <Typography component="p" role="alert" variant="metadata" color="error.main">{error}</Typography> : null}

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {draftResearchId ? (
            <Button type="button" size="xs" variant="outline" onClick={() => void recheck()} disabled={busyClaimId === '__recheck__'}>
              <RefreshCw size={12} aria-hidden />
              {busyClaimId === '__recheck__' ? '正在重新检查…' : '重新检查'}
            </Button>
          ) : null}
          {draftResearchId ? (
            <Button asChild size="xs" variant="outline">
              <NextLink href={`/researches/${draftResearchId}/edit`}>在草稿中修改正文</NextLink>
            </Button>
          ) : null}
        </Box>
      </Box>
    </Box>
  );

  function claimList() {
    if (claims.length === 0) {
      return <Typography component="p" variant="metadata" color="text.secondary">这一轮还没有逐条结论。</Typography>;
    }
    if (open.length === 0) {
      return <Typography component="p" variant="metadata" color="success.main">所有结论都有直接依据或已由你处理。</Typography>;
    }
    return (
      <Box component="ul" sx={{ m: 0, p: 0, display: 'grid', gap: 1, listStyle: 'none', maxHeight: 360, overflowY: 'auto' }}>
        {open.map((claim, index) => {
          const claimId = reviewClaimId(claim) ?? `claim-${index}`;
          const evidenceStatus = claimEvidenceStatus(claim);
          const style = STATUS_STYLES[evidenceStatus] ?? STATUS_STYLES.unverified;
          const risk = claim.risk?.toLowerCase();
          const canAccept = evidenceStatus === 'unverified' && risk !== 'high';
          return (
            <Box component="li" key={claimId} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 1.5, py: 1 }}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Box component="span" sx={{ ...style.sx, borderRadius: 999, px: 1, py: 0.25, typography: 'metadata' }}>
                  {style.label}
                </Box>
                {claim.risk ? (
                  <Typography component="span" variant="metadata" color="text.secondary">风险 {claim.risk}</Typography>
                ) : null}
              </Box>
              <Typography component="p" variant="metadata" sx={{ lineHeight: 1.6, overflowWrap: 'anywhere' }}>
                {claim.claim ?? '（无正文）'}
              </Typography>
              <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {canAccept ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busyClaimId === claimId}
                    onClick={() => { setReasonFor({ claimId, action: 'accept_uncertainty' }); setReason(''); }}
                  >
                    <Check size={12} aria-hidden />
                    接受为待验证项
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busyClaimId === claimId}
                  onClick={() => void submitDecision(claim, 'request_verification')}
                >
                  请求重新核对
                </Button>
                {evidenceStatus === 'supported' ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={busyClaimId === claimId}
                    onClick={() => { setReasonFor({ claimId, action: 'challenge_support' }); setReason(''); }}
                  >
                    <AlertTriangle size={12} aria-hidden />
                    质疑这条依据
                  </Button>
                ) : null}
              </Box>
              {reasonFor?.claimId === claimId ? (
                <Box sx={{ mt: 1, display: 'grid', gap: 1 }}>
                  <Typography component="span" variant="metadata" color="text.secondary">
                    {reasonFor.action === 'accept_uncertainty'
                      ? '说明为什么这条可以带着不确定性发布：'
                      : '说明为什么当前摘录不足以支持这条结论：'}
                  </Typography>
                  <Box
                    component="textarea"
                    value={reason}
                    onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setReason(event.target.value)}
                    rows={2}
                    aria-label="处理理由"
                    sx={{ width: '100%', resize: 'vertical', border: 1, borderColor: 'divider', borderRadius: 1, p: 1, typography: 'metadata', font: 'inherit', bgcolor: 'background.paper' }}
                  />
                  <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                    <Button type="button" size="xs" variant="ghost" onClick={() => { setReasonFor(null); setReason(''); }}>取消</Button>
                    <Button
                      type="button"
                      size="xs"
                      disabled={!reason.trim() || busyClaimId === claimId}
                      onClick={() => void submitDecision(claim, reasonFor.action, reason)}
                    >
                      {busyClaimId === claimId ? '保存中…' : '确认'}
                    </Button>
                  </Box>
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
    );
  }
}
