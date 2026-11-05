'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Paper, Typography } from '@mui/material';

type Preset = {
  id: string; name: string; description: string; feedUrl: string;
  existing: Array<{ id: string; name: string; enabled: boolean; autoPaused: boolean }>;
};

export function RadarSourcePresets() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const presets = useQuery<{ items: Preset[] }>({
    queryKey: ['admin-radar-source-presets'],
    queryFn: async () => {
      const response = await fetch('/api/admin/radar/source-presets', { cache: 'no-store' });
      if (!response.ok) throw new Error('来源列表加载失败');
      return response.json();
    },
  });
  const add = useMutation({
    mutationFn: async (presetId: string) => {
      const response = await fetch('/api/admin/radar/source-presets', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ presetId }),
      });
      if (!response.ok) throw new Error('添加失败，请稍后重试');
      return response.json() as Promise<{ created: boolean }>;
    },
    onSuccess: (result) => {
      setMessage(result.created ? '来源已添加，将按现有同步计划读取。' : '来源已存在，原有配置和启停状态未改变。');
      void queryClient.invalidateQueries({ queryKey: ['admin-radar-source-presets'] });
    },
    onError: () => setMessage('添加失败，请稍后重试。'),
  });
  return (
    <Paper variant="outlined" component="section" aria-labelledby="source-presets-heading" sx={{ p: 2 }}>
      <Typography id="source-presets-heading" variant="h6">添加技术信息源</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        从已验证的来源中选择；添加后按现有计划同步。已有来源不会被修改或重新启用。
      </Typography>
      {message && <Alert severity={add.isError ? 'error' : 'success'} sx={{ mt: 1 }} role="status">{message}</Alert>}
      {presets.isError && <Alert severity="error" sx={{ mt: 1 }}>来源列表加载失败，请刷新重试。</Alert>}
      {presets.isLoading && <Typography sx={{ mt: 1 }}>正在加载来源…</Typography>}
      <Box sx={{ display: 'grid', gap: 1, mt: 1, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' } }}>
        {presets.data?.items.map((preset) => (
          <Box key={preset.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, minWidth: 0 }}>
            <Typography variant="subtitle1">{preset.name}</Typography>
            <Typography variant="body2" color="text.secondary">{preset.description}</Typography>
            <Typography component="a" href={preset.feedUrl} target="_blank" rel="noopener noreferrer" variant="caption" sx={{ display: 'block', overflowWrap: 'anywhere', mt: 0.5 }}>{preset.feedUrl}</Typography>
            {preset.existing.length ? <Box sx={{ mt: 1 }}>
              {preset.existing.map((source) => <Typography variant="body2" key={source.id}>
                已存在：{source.name}（{!source.enabled ? '已停用' : source.autoPaused ? '自动暂停' : '已启用'}）
              </Typography>)}
            </Box> : <Button variant="outlined" size="small" sx={{ mt: 1 }} disabled={add.isPending} onClick={() => add.mutate(preset.id)} aria-label={`添加 ${preset.name}`}>
              {add.isPending && add.variables === preset.id ? '正在添加…' : '添加来源'}
            </Button>}
          </Box>
        ))}
      </Box>
    </Paper>
  );
}
