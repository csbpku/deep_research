'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Layers3, Loader2, Sparkles, X } from 'lucide-react';

import { AdminActionDialog } from '@/components/admin/AdminActionDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/EmptyState';

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
  const [drafts, setDrafts] = useState<Record<string, { name: string; proposition: string; selected: string[] }>>({});
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
      return body as { proposalsCreated: number };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-topic-proposals'] }),
  });

  const reviewMut = useMutation({
    mutationFn: async (input: { id: string; action: 'approve' | 'reject'; name?: string; proposition?: string; includedSummaryIds?: string[]; reason?: string }) => {
      const response = await fetch(`/api/admin/topic-proposals/${input.id}/review`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { message?: string }).message ?? '审核操作失败');
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-topic-proposals'] });
      queryClient.invalidateQueries({ queryKey: ['topics'] });
    },
  });

  const getDraft = (proposal: Proposal) => drafts[proposal.id] ?? {
    name: proposal.name,
    proposition: proposal.proposition,
    selected: proposal.candidates.map((candidate) => candidate.summaryId),
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-amber-300/60 bg-amber-50/70 p-4 dark:border-amber-500/30 dark:bg-amber-950/20">
        <div className="flex gap-3">
          <div className="mt-0.5 rounded-md bg-amber-200/70 p-2 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200"><Layers3 className="size-4" /></div>
          <div>
            <h2 className="text-sm font-semibold">主题提议审核</h2>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">算法只提出“共同事件 / 共同问题”，不会直接出现在用户侧。请先确认共同命题和证据，再发布为热点主题。</p>
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={generateMut.isPending} onClick={() => generateMut.mutate()}>
          {generateMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          生成新提议
        </Button>
      </div>

      {generateMut.isError ? <p className="text-xs text-destructive">{(generateMut.error as Error).message}</p> : null}
      {reviewMut.isError ? <p className="text-xs text-destructive">{(reviewMut.error as Error).message}</p> : null}
      {q.isLoading ? <div className="h-24 animate-pulse rounded-lg bg-muted" /> : null}
      {q.isError ? <p className="text-sm text-destructive">{(q.error as Error).message}</p> : null}
      {!q.isLoading && (q.data?.items.length ?? 0) === 0 ? (
        <EmptyState title="没有待审核提议" description="点击“生成新提议”分析最近 14 天的标题和 enrichment 内容。审核通过后，主题才会出现在公开热点列表。" />
      ) : null}

      {(q.data?.items ?? []).map((proposal) => {
        const draft = getDraft(proposal);
        return (
          <Card key={proposal.id} className="overflow-hidden border-border/80">
            <CardContent className="p-0">
              <div className="border-l-4 border-l-amber-400 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{proposal.kind === 'event' ? '共同事件' : '共同问题'}</Badge>
                      <span className="text-xs text-muted-foreground">{proposal.candidateCount} 条资料 · {proposal.sourceCount} 个发布方</span>
                      {proposal.confidence !== null ? <span className="font-mono text-xs text-muted-foreground">模型置信度 {Math.round(proposal.confidence * 100)}%</span> : null}
                    </div>
                    <label className="mt-3 block text-xs font-medium text-muted-foreground" htmlFor={`proposal-name-${proposal.id}`}>主题名称</label>
                    <input id={`proposal-name-${proposal.id}`} className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm font-semibold outline-none focus:ring-2 focus:ring-ring" value={draft.name} onChange={(event) => setDrafts({ ...drafts, [proposal.id]: { ...draft, name: event.target.value } })} />
                    <label className="mt-2 block text-xs font-medium text-muted-foreground" htmlFor={`proposal-proposition-${proposal.id}`}>共同命题</label>
                    <textarea id={`proposal-proposition-${proposal.id}`} rows={2} className="mt-1 w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-ring" value={draft.proposition} onChange={(event) => setDrafts({ ...drafts, [proposal.id]: { ...draft, proposition: event.target.value } })} />
                  </div>
                </div>
                <div className="mt-4 border-t border-border/70 pt-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">证据资料 · 勾选后发布</p>
                  <div className="grid gap-2">
                    {proposal.candidates.map((candidate) => {
                      const checked = draft.selected.includes(candidate.summaryId);
                      return (
                        <label key={candidate.id} className="flex cursor-pointer gap-2 rounded-md border border-border/70 p-2.5 transition-colors hover:bg-muted/40">
                          <input type="checkbox" className="mt-1 size-4 accent-[hsl(var(--primary))]" checked={checked} onChange={(event) => setDrafts({ ...drafts, [proposal.id]: { ...draft, selected: event.target.checked ? [...draft.selected, candidate.summaryId] : draft.selected.filter((id) => id !== candidate.summaryId) } })} />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium"><span>{candidate.summary.title}</span><span className="text-xs font-normal text-muted-foreground">{sourceLabel(candidate.summary.url)}</span></span>
                            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{candidate.evidence || candidate.summary.interpretation || candidate.summary.tldr || '暂无提取证据，请打开原文核对。'}</span>
                          </span>
                          <a href={candidate.summary.url} target="_blank" rel="noreferrer" aria-label="打开原文" className="shrink-0 text-muted-foreground hover:text-primary"><ExternalLink className="size-3.5" /></a>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">已选择 {draft.selected.length} 条 · 至少 3 条且来自 2 个独立发布方</span>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="outline" className="text-destructive" disabled={reviewMut.isPending} onClick={() => setRejecting(proposal)}><X className="size-4" />驳回</Button>
                    <Button type="button" size="sm" disabled={reviewMut.isPending || draft.selected.length < 3} onClick={() => reviewMut.mutate({ id: proposal.id, action: 'approve', name: draft.name, proposition: draft.proposition, includedSummaryIds: draft.selected })}><Check className="size-4" />发布主题</Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <AdminActionDialog open={!!rejecting} onOpenChange={(open) => !open && setRejecting(null)} title="驳回主题提议" description={rejecting ? <>提议：<strong className="font-medium text-foreground">{rejecting.name}</strong></> : undefined} fields={[{ kind: 'textarea', id: 'reason', label: '驳回原因', required: true, rows: 3, placeholder: '例如：命题过于宽泛 / 候选并非同一问题 / 与已有主题重复' }]} confirmLabel="确认驳回" destructive pending={reviewMut.isPending} onSubmit={async (values) => { if (!rejecting) return; await reviewMut.mutateAsync({ id: rejecting.id, action: 'reject', reason: String(values.reason) }); setRejecting(null); }} />
    </div>
  );
}
