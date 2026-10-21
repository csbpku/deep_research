'use client';

// P1-D: Admin 手动触发主题聚合 / 综述。
// 挂在 /topics PageHeader 的 actions 槽。
// - 综述：跑 LLM 写 topic.synthesisPayload
// 通过 /api/admin/topics/* BFF → ai-engine，需要 INTERNAL_SERVICE_TOKEN。

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { Sparkles } from 'lucide-react';

import { AppButton as Button } from '@/components/material/AppButton';

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
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5 }}>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button
          type="button"
          variant="outlined"
          disabled={busy}
          onClick={() => synthesizeMut.mutate()}
          aria-label="生成 AI 综述"
          startIcon={synthesizeMut.isPending ? <CircularProgress size={16} color="inherit" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
        >
          生成 AI 综述
        </Button>
      </Box>
      {message ? (
        <Typography variant="metadata" color="success.main" role="status">
          {message}
        </Typography>
      ) : null}
      {error ? (
        <Typography variant="metadata" color="error.main" role="alert">
          {error}
        </Typography>
      ) : null}
    </Box>
  );
}
