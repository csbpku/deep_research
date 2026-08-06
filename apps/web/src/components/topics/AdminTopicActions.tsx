'use client';

// P1-D: Admin 手动触发主题聚合 / 综述。
// 挂在 /topics PageHeader 的 actions 槽。
// - 综述：跑 LLM 写 topic.synthesisPayload
// 通过 /api/admin/topics/* BFF → ai-engine，需要 INTERNAL_SERVICE_TOKEN。

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface SynthesizeResp {
  processed: number;
  succeeded: number;
  failed: number;
}

export function AdminTopicActions() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const busy = synthesizeMut.isPending;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
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
