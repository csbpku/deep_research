'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { Check, ChevronDown, ExternalLink, Layers3, RefreshCw, Sparkles, X } from 'lucide-react';
import NextLink from 'next/link';

import { AdminActionDialog } from '@/components/admin/AdminActionDialog';
import { AppButton as Button, AppIconButton } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import { AppTextField } from '@/components/material/AppTextField';
import { EmptyState } from '@/components/EmptyState';
import { topicProposalReviewPayload } from '@/lib/topic-proposal-review';

type RegenerateResponse = {
  aggregate: { body: { topicsCreated: number; candidatesLinked: number; staleRemoved: number } };
  synthesis: { body: { processed: number; succeeded: number; failed: number; skipped: number } };
  proposals: { body: { proposalsCreated: number; candidatesLinked: number; failed: number; eligibleCandidates: number; failureReason: string } };
};

type Candidate = {
  id: string;
  summaryId: string;
  fitScore: number | null;
  evidence: string | null;
  summary: {
    id: string;
    title: string;
    url: string;
    interpretation: string | null;
    tldr: string | null;
    repoSummary: string | null;
    arxivAnalysis: unknown;
    highlights: unknown;
    originalKind: string | null;
  };
};

type Proposal = {
  id: string;
  name: string;
  proposition: string;
  kind: 'event' | 'problem';
  confidence: number | null;
  candidateCount: number;
  sourceCount: number;
  candidates: Candidate[];
};

type ReviewResponse =
  | { ok: true; action: 'approve'; topic?: { id: string; slug: string } }
  | { ok: true; action: 'reject' };

type ProposalFilter = 'all' | 'high_confidence' | 'evidence_gap' | 'publish_ready';

function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return '未知来源';
  }
}

export function TopicProposalsTab() {
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState<Proposal | null>(null);
  const [generationMessage, setGenerationMessage] = useState<string | null>(null);
  const [regenerateMessage, setRegenerateMessage] = useState<string | null>(null);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [publishedTopic, setPublishedTopic] = useState<{ name: string; slug: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { name: string; proposition: string; selected: string[] }>>({});
  const [proposalFilter, setProposalFilter] = useState<ProposalFilter>('all');
  const [expandedEvidence, setExpandedEvidence] = useState<Record<string, boolean>>({});
  const q = useQuery<{ items: Proposal[] }>({
    queryKey: ['admin-topic-proposals', 'proposed'],
    queryFn: async () => {
      const response = await fetch('/api/admin/topic-proposals?status=proposed', { cache: 'no-store' });
      if (!response.ok) throw new Error('主题提议加载失败');
      return response.json();
    },
  });

  const generateMut = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/admin/topic-proposals/generate', { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { message?: string }).message ?? '生成提议失败');
      return body as { proposalsCreated: number; candidatesLinked: number; failed: number; eligibleCandidates: number; failureReason: string };
    },
    onSuccess: (result) => {
      if (result.failed > 0) {
        setGenerationMessage(`生成失败：${result.failureReason || 'AI 模型调用失败'}（已筛选 ${result.eligibleCandidates} 条候选）`);
      } else if (result.proposalsCreated === 0) {
        setGenerationMessage(`本次没有形成主题：${result.failureReason === 'NO_QUALIFYING_CLUSTER' ? '模型未找到同时满足“至少 3 条资料 + 2 个独立发布方”的共同命题' : '候选不足'}。当前有效候选 ${result.eligibleCandidates} 条。`);
      } else {
        setGenerationMessage(`已生成 ${result.proposalsCreated} 个待审核提议，关联 ${result.candidatesLinked} 条证据。`);
      }
      queryClient.invalidateQueries({ queryKey: ['admin-topic-proposals'] });
    },
  });

  const regenerateMut = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/admin/topics/regenerate', { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          (body as { message?: string }).message ?? '重新发现热点主题失败',
        );
      }
      return body as RegenerateResponse;
    },
    onSuccess: (result) => {
      const synth = result.synthesis.body;
      const props = result.proposals.body;
      const parts = [
        `聚合清理 ${result.aggregate.body.staleRemoved} 条旧 candidate`,
        `重生成综述 ${synth.succeeded}/${synth.processed}（跳过 ${synth.skipped}）`,
        `生成提议 ${props.proposalsCreated} 个（失败 ${props.failed}）`,
      ];
      setRegenerateMessage(parts.join('；') + '。');
      queryClient.invalidateQueries({ queryKey: ['admin-topic-proposals'] });
      queryClient.invalidateQueries({ queryKey: ['topics'] });
    },
  });

  const reviewMut = useMutation({
    mutationFn: async (input: { id: string; action: 'approve' | 'reject'; name?: string; proposition?: string; includedSummaryIds?: string[]; reason?: string }) => {
      const response = await fetch(`/api/admin/topic-proposals/${input.id}/review`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(topicProposalReviewPayload(input)),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { message?: string }).message ?? '审核操作失败');
      return body as ReviewResponse;
    },
    onSuccess: (result, input) => {
      if (result.action === 'approve' && result.topic) {
        setPublishedTopic({ name: input.name ?? '', slug: result.topic.slug });
      }
      queryClient.invalidateQueries({ queryKey: ['admin-topic-proposals'] });
      queryClient.invalidateQueries({ queryKey: ['topics'] });
    },
  });

  const getDraft = (proposal: Proposal) => drafts[proposal.id] ?? {
    name: proposal.name,
    proposition: proposal.proposition,
    selected: proposal.candidates.map((candidate) => candidate.summaryId),
  };

  const proposals = q.data?.items ?? [];
  const visibleProposals = useMemo(() => proposals.filter((proposal) => {
    if (proposalFilter === 'high_confidence') return (proposal.confidence ?? 0) >= 0.8;
    if (proposalFilter === 'evidence_gap') return proposal.candidateCount < 3 || proposal.sourceCount < 2;
    if (proposalFilter === 'publish_ready') {
      const draft = getDraft(proposal);
      const selectedSources = new Set(
        proposal.candidates
          .filter((candidate) => draft.selected.includes(candidate.summaryId))
          .map((candidate) => sourceLabel(candidate.summary.url)),
      );
      return Boolean(draft.name.trim() && draft.proposition.trim())
        && draft.selected.length >= 3
        && selectedSources.size >= 2;
    }
    return true;
  }), [drafts, proposalFilter, proposals]);

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1.5, border: 1, borderColor: 'color-mix(in srgb, var(--dr-color-warning) 45%, var(--dr-color-outline))', bgcolor: 'color-mix(in srgb, var(--dr-color-warning-container) 55%, var(--dr-color-surface))', borderRadius: 'var(--dr-radius-medium)', p: 2 }}>
        <Box sx={{ display: 'flex', gap: 1.5 }}>
          <Box sx={{ mt: 0.5, display: 'inline-flex', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'var(--dr-color-warning-container)', color: 'warning.main', p: 1 }}><Layers3 size={16} aria-hidden="true" /></Box>
          <Box>
            <Typography component="h2" variant="listTitle">主题提议审核</Typography>
            <Typography component="p" variant="metadata" color="text.secondary" sx={{ mt: 0.5, maxWidth: 640 }}>算法只提出“共同事件 / 共同问题”，不会直接出现在用户侧。请先确认共同命题和证据，再发布为热点主题。</Typography>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
          <Button
            type="button"
            variant="outlined"
            disabled={regenerateMut.isPending || generateMut.isPending}
            startIcon={regenerateMut.isPending ? <CircularProgress size={16} color="inherit" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            onClick={() => setConfirmingRegenerate(true)}
          >
            重新发现热点主题
          </Button>
          <Button type="button" variant="outlined" disabled={generateMut.isPending || regenerateMut.isPending} startIcon={generateMut.isPending ? <CircularProgress size={16} color="inherit" aria-hidden="true" /> : <Sparkles aria-hidden="true" />} onClick={() => generateMut.mutate()}>
            生成主题提议
          </Button>
        </Box>
      </Box>

      {generationMessage ? <Alert severity="info" variant="outlined" role="status">{generationMessage}</Alert> : null}
      {regenerateMessage ? <Alert severity="info" variant="outlined" role="status">{regenerateMessage}</Alert> : null}
      {regenerateMut.isError ? <Alert severity="error" role="alert">{(regenerateMut.error as Error).message}</Alert> : null}
      {publishedTopic ? (
        <Alert severity="success" role="status">
          已发布「{publishedTopic.name}」：
          <Link component={NextLink} href={`/topics/${publishedTopic.slug}`} underline="hover" sx={{ ml: 0.5 }}>查看主题</Link>
        </Alert>
      ) : null}
      {generateMut.isError ? <Alert severity="error" role="alert">{(generateMut.error as Error).message}</Alert> : null}
      {reviewMut.isError ? <Alert severity="error" role="alert">{(reviewMut.error as Error).message}</Alert> : null}
      {q.isLoading ? <Skeleton variant="rounded" height={96} /> : null}
      {q.isError ? <Alert severity="error" role="alert">{(q.error as Error).message}</Alert> : null}
      {!q.isLoading && (q.data?.items.length ?? 0) === 0 ? (
        <EmptyState title="没有待审核提议" description="点击“生成主题提议”分析最近 14 天的标题和 enrichment 内容。审核通过后，主题才会出现在公开热点列表。" />
      ) : null}

      {proposals.length > 0 ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 1, border: 1, borderColor: 'divider', bgcolor: 'background.paper', borderRadius: 'var(--dr-radius-medium)', px: 1.5, py: 1.5 }} role="toolbar" aria-label="主题提议筛选">
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
            <Typography variant="metadata" color="text.secondary" sx={{ fontWeight: 500, mr: 0.5 }}>筛选</Typography>
            {([
              ['all', '全部'],
              ['high_confidence', '高置信度'],
              ['evidence_gap', '证据不足'],
              ['publish_ready', '可发布'],
            ] as const).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                variant={proposalFilter === value ? 'outlined' : 'text'}
                color={proposalFilter === value ? 'primary' : 'inherit'}
                aria-pressed={proposalFilter === value}
                onClick={() => setProposalFilter(value)}
                sx={{
                  border: 1,
                  borderColor: proposalFilter === value ? 'color-mix(in srgb, var(--dr-color-primary) 40%, var(--dr-color-outline))' : 'transparent',
                  bgcolor: proposalFilter === value ? 'action.selected' : 'transparent',
                  color: proposalFilter === value ? 'primary.main' : 'text.secondary',
                  '&:hover': { borderColor: 'divider', bgcolor: 'action.hover', color: 'text.primary' },
                }}
              >
                {label}
              </Button>
            ))}
          </Box>
          <Typography component="span" variant="metadata" color="text.secondary" role="status">
            显示 {visibleProposals.length} / {proposals.length} 个提议
          </Typography>
        </Box>
      ) : null}

      {proposals.length > 0 && visibleProposals.length === 0 ? (
        <EmptyState title="没有符合当前筛选的提议" description="可以切换筛选条件，或先打开证据资料调整选择。" />
      ) : null}

      {visibleProposals.map((proposal) => {
        const draft = getDraft(proposal);
        const evidenceOpen = expandedEvidence[proposal.id] ?? false;
        return (
          <Card key={proposal.id} variant="outlined" sx={{ overflow: 'hidden', borderColor: 'divider', borderRadius: 'var(--dr-radius-medium)' }}>
            <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
              <Box sx={{ borderLeft: '4px solid var(--dr-color-warning)', p: 2 }}>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1.5 }}>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
                      <Chip size="small" variant="outlined" label={proposal.kind === 'event' ? '共同事件' : '共同问题'} sx={{ bgcolor: 'action.hover' }} />
                      <Typography variant="metadata" color="text.secondary">{proposal.candidateCount} 条资料 · {proposal.sourceCount} 个发布方</Typography>
                      {proposal.confidence !== null ? <Typography variant="metadata" color="text.secondary" sx={{ fontFamily: 'monospace' }}>模型置信度 {Math.round(proposal.confidence * 100)}%</Typography> : null}
                    </Box>
                    <Typography component="label" variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 1.5, mb: 0.5, fontWeight: 500 }} htmlFor={`proposal-name-${proposal.id}`}>主题名称</Typography>
                    <AppTextField id={`proposal-name-${proposal.id}`} value={draft.name} onChange={(event) => setDrafts({ ...drafts, [proposal.id]: { ...draft, name: event.target.value } })} sx={{ '& input': { fontWeight: 600 } }} />
                    <Typography component="label" variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 1, mb: 0.5, fontWeight: 500 }} htmlFor={`proposal-proposition-${proposal.id}`}>共同命题</Typography>
                    <TextField id={`proposal-proposition-${proposal.id}`} fullWidth multiline rows={2} value={draft.proposition} onChange={(event) => setDrafts({ ...drafts, [proposal.id]: { ...draft, proposition: event.target.value } })} sx={{ '& .MuiInputBase-inputMultiline': { resize: 'vertical' } }} />
                  </Box>
                </Box>
                <Box sx={{ mt: 2, borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
                  <Button
                    fullWidth
                    variant="text"
                    color="inherit"
                    sx={{ justifyContent: 'space-between', px: 1, py: 1, textAlign: 'left', whiteSpace: 'normal', color: 'text.secondary', '&:hover': { bgcolor: 'action.hover', color: 'text.primary' } }}
                    type="button"
                    aria-expanded={evidenceOpen}
                    onClick={() => setExpandedEvidence((current) => ({ ...current, [proposal.id]: !evidenceOpen }))}
                  >
                    <Typography component="span" variant="metadata" sx={{ fontWeight: 500 }}>证据资料 · 已选择 {draft.selected.length} / {proposal.candidates.length} 条 · 勾选后发布</Typography>
                    <Box component="span" sx={{ display: 'inline-flex', flexShrink: 0, transform: evidenceOpen ? 'rotate(180deg)' : 'none', transition: 'transform var(--dr-motion-fast)' }}><ChevronDown size={16} aria-hidden="true" /></Box>
                  </Button>
                  {evidenceOpen ? (
                    <Box sx={{ mt: 1, display: 'grid', gap: 1 }}>
                      {proposal.candidates.map((candidate) => {
                        const checked = draft.selected.includes(candidate.summaryId);
                        return (
                          <Box key={candidate.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, border: 1, borderColor: 'divider', borderRadius: 'var(--dr-radius-medium)', p: 1.5, '&:hover': { bgcolor: 'action.hover' } }}>
                            <FormControlLabel
                              sx={{ m: 0, minWidth: 0, flex: 1, alignItems: 'flex-start', '& .MuiFormControlLabel-label': { minWidth: 0, flex: 1 } }}
                              control={<Checkbox size="small" checked={checked} onChange={(event) => setDrafts({ ...drafts, [proposal.id]: { ...draft, selected: event.target.checked ? [...draft.selected, candidate.summaryId] : draft.selected.filter((id) => id !== candidate.summaryId) } })} sx={{ mt: 0.25, mr: 0.5 }} />}
                              label={(
                                <Box component="span" sx={{ display: 'block', minWidth: 0, pt: 0.25 }}>
                                  <Box component="span" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
                                    <Typography variant="body2" sx={{ fontWeight: 500 }}>{candidate.summary.title}</Typography>
                                    <Typography variant="metadata" color="text.secondary">{sourceLabel(candidate.summary.url)}</Typography>
                                  </Box>
                                  <Typography component="span" variant="metadata" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>{candidate.evidence || candidate.summary.interpretation || candidate.summary.tldr || '暂无提取证据，请打开原文核对。'}</Typography>
                                </Box>
                              )}
                            />
                            <AppIconButton component="a" href={candidate.summary.url} target="_blank" rel="noreferrer" aria-label="打开原文" size="small" sx={{ flexShrink: 0, color: 'text.secondary' }}>
                              <ExternalLink size={14} aria-hidden="true" />
                            </AppIconButton>
                          </Box>
                        );
                      })}
                    </Box>
                  ) : null}
                </Box>
                <Box sx={{ mt: 2, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                  <Typography variant="metadata" color="text.secondary">已选择 {draft.selected.length} 条 · 至少 3 条且来自 2 个独立发布方</Typography>
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    <Button type="button" variant="outlined" color="error" disabled={reviewMut.isPending} onClick={() => setRejecting(proposal)} startIcon={<X aria-hidden="true" />}>驳回</Button>
                    <Button type="button" disabled={reviewMut.isPending || draft.selected.length < 3} onClick={() => reviewMut.mutate({ id: proposal.id, action: 'approve', name: draft.name, proposition: draft.proposition, includedSummaryIds: draft.selected })} startIcon={<Check aria-hidden="true" />}>发布主题</Button>
                  </Box>
                </Box>
              </Box>
            </CardContent>
          </Card>
        );
      })}

      <AdminActionDialog open={!!rejecting} onOpenChange={(open) => !open && setRejecting(null)} title="驳回主题提议" description={rejecting ? <>提议：<Typography component="strong" variant="body2" sx={{ fontWeight: 500 }}>{rejecting.name}</Typography></> : undefined} fields={[{ kind: 'textarea', id: 'reason', label: '驳回原因', required: true, rows: 3, placeholder: '例如：命题过于宽泛 / 候选并非同一问题 / 与已有主题重复' }]} confirmLabel="确认驳回" destructive pending={reviewMut.isPending} onSubmit={async (values) => { if (!rejecting) return; await reviewMut.mutateAsync({ id: rejecting.id, action: 'reject', reason: String(values.reason) }); setRejecting(null); }} />
      <AppDialog
        open={confirmingRegenerate}
        onClose={() => setConfirmingRegenerate(false)}
        title="重新发现热点主题？"
        description="重新发现热点主题会清掉旧 candidates 并跑两次 LLM（综述 + 提议），通常需要数分钟，是否继续？"
        actions={(
          <>
            <Button type="button" variant="outlined" onClick={() => setConfirmingRegenerate(false)}>
              取消
            </Button>
            <Button
              type="button"
              variant="contained"
              color="error"
              onClick={() => {
                setConfirmingRegenerate(false);
                regenerateMut.mutate();
              }}
            >
              继续重新发现
            </Button>
          </>
        )}
      />
    </Box>
  );
}
