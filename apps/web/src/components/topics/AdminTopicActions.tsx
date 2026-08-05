'use client';

// P1-D: Admin 手动触发主题聚合 / 综述。
// 挂在 /topics PageHeader 的 actions 槽。
// - 提议：对最近 14 天 summaries 跑标题/enrichment 聚类，写入审核队列
// - 综述：跑 LLM 写 topic.synthesisPayload
// 两者都通过 /api/admin/topics/* BFF → ai-engine，需要 INTERNAL_SERVICE_TOKEN。

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface AggregateResp {
  topicsCreated: number;
  candidatesLinked: number;
  staleRemoved: number;
  topicsRetired: number;
  proposalsCreated: number;
  proposalCandidatesLinked: number;
  proposalFailed: number;
}

interface SynthesizeResp {
  processed: number;
  succeeded: number;
  failed: number;
}

export function AdminTopicActions() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const aggregateMut = useMutation({
    mutationFn: async (): Promise<AggregateResp> => {
      const r = await fetch('/api/admin/topics/aggregate', { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(
          (data as { message?: string }).message ??
            `HTTP ${r.status}：聚合失败`,
        );
      }
      return data as AggregateResp;
    },
    onSuccess: (res) => {
      setError(null);
      setMessage(
        `提议生成完成：${res.proposalsCreated} 个提议 · 关联 ${res.proposalCandidatesLinked} 条证据 · 下线 ${res.topicsRetired} 个旧主题${res.proposalFailed ? ` · 失败 ${res.proposalFailed}` : ''}`,
      );
      queryClient.invalidateQueries({ queryKey: ['topics'] });
      router.refresh();
    },
    onError: (e) => {
      setMessage(null);
      setError((e as Error).message);
    },
  });

  const synthesizeMut = useMutation({
    mutationFn: async (): Promise<SynthesizeResp> => {
      const r = await fetch('/api/admin/topics/synthesize', { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(
          (data as { message?: string }).message ??
            `HTTP ${r.status}：综述失败`,
        );
      }
      return data as SynthesizeResp;
    },
    onSuccess: (res) => {
      setError(null);
      setMessage(
        `综述：处理 ${res.processed} · 成功 ${res.succeeded} · 失败 ${res.failed}`,
      );
      queryClient.invalidateQueries({ queryKey: ['topics'] });
    },
    onError: (e) => {
      setMessage(null);
      setError((e as Error).message);
    },
  });

  const busy = aggregateMut.isPending || synthesizeMut.isPending;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => aggregateMut.mutate()}
          aria-label="生成主题提议"
        >
          {aggregateMut.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          生成主题提议
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => synthesizeMut.mutate()}
          aria-label="生成 AI 综述"
        >
          {synthesizeMut.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          生成 AI 综述
        </Button>
      </div>
      {message ? (
        <p className="text-xs text-status-succeeded-fg" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
