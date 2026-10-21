'use client';

// /me 设置：preferences 表单。
// 仅展示已真正接入 AI 调研表单的偏好；未生效的配置不暴露给用户。
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { space } from '@deep-research/design-system';

import { AppButton as Button } from '@/components/material/AppButton';
import type { UserPreferences } from '@/lib/me/preferences-schema';

type Preferences = UserPreferences;

const ALL = '__all__';

export function PreferencesForm({ userEmail }: { userEmail: string }) {
  const q = useQuery<{ preferences: Preferences }>({
    queryKey: ['me-preferences'],
    queryFn: async () => {
      const r = await fetch('/api/me/preferences', { cache: 'no-store' });
      if (!r.ok) throw new Error('加载失败');
      return r.json();
    },
  });

  const [prefs, setPrefs] = useState<Preferences>({});
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) setPrefs(q.data.preferences ?? {});
  }, [q.data]);

  const saveMut = useMutation({
    mutationFn: async (next: Preferences) => {
      const r = await fetch('/api/me/preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? '保存失败');
      }
      return r.json() as Promise<{ preferences: Preferences }>;
    },
    onSuccess: (res) => {
      setPrefs(res.preferences);
      setSavedAt(new Date().toLocaleTimeString('zh-CN'));
    },
  });

  if (q.isLoading) return <Skeleton variant="rounded" height={184} />;
  if (q.isError) return <Alert severity="error">{(q.error as Error).message}</Alert>;

  return (
    <Box sx={{ display: 'grid', gap: space.md, minWidth: 0 }}>
      <Card variant="outlined">
        <CardContent sx={{ display: 'grid', gap: space.xs, p: space.lg, '&:last-child': { pb: space.lg } }}>
          <Typography component="h2" variant="fieldTitle">账号</Typography>
          <Typography component="p" variant="metadata" color="text.secondary" sx={{ m: 0, overflowWrap: 'anywhere' }}>{userEmail}</Typography>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) minmax(220px, 280px)' }, alignItems: 'center', gap: space.md, p: space.lg, '&:last-child': { pb: space.lg } }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography component="h2" variant="fieldTitle">默认报告类型</Typography>
            <Typography component="p" variant="metadata" color="text.secondary" sx={{ mt: space.xs, mb: 0 }}>新建 AI 调研时默认的报告格式。</Typography>
          </Box>
          <FormControl fullWidth size="small">
            <InputLabel id="me-default-report-type-label">默认报告类型</InputLabel>
            <Select<string>
              labelId="me-default-report-type-label"
              label="默认报告类型"
              value={prefs.defaultReportType ?? ALL}
              onChange={(event) => setPrefs((p) => ({
                ...p,
                defaultReportType: event.target.value === ALL ? undefined : event.target.value as Preferences['defaultReportType'],
              }))}
            >
              <MenuItem value={ALL}>未设置</MenuItem>
              <MenuItem value="research_report">完整调研报告</MenuItem>
              <MenuItem value="summary_brief">快速判断</MenuItem>
              <MenuItem value="slides">Slides 提纲</MenuItem>
              <MenuItem value="web_brief">网页简报</MenuItem>
            </Select>
          </FormControl>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) minmax(220px, 280px)' }, alignItems: 'center', gap: space.md, p: space.lg, '&:last-child': { pb: space.lg } }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography component="h2" variant="fieldTitle">默认来源策略</Typography>
            <Typography component="p" variant="metadata" color="text.secondary" sx={{ mt: space.xs, mb: 0 }}>影响 AI 调研抓取来源的范围。</Typography>
          </Box>
          <FormControl fullWidth size="small">
            <InputLabel id="me-default-source-policy-label">默认来源策略</InputLabel>
            <Select<string>
              labelId="me-default-source-policy-label"
              label="默认来源策略"
              value={prefs.defaultSourcePolicy ?? ALL}
              onChange={(event) => setPrefs((p) => ({
                ...p,
                defaultSourcePolicy: event.target.value === ALL ? undefined : event.target.value as Preferences['defaultSourcePolicy'],
              }))}
            >
              <MenuItem value={ALL}>未设置</MenuItem>
              <MenuItem value="prefer_user_sources">优先指定资料，可补充搜索</MenuItem>
              <MenuItem value="only_user_sources">仅使用指定资料</MenuItem>
              <MenuItem value="web_only">仅使用网页搜索</MenuItem>
            </Select>
          </FormControl>
        </CardContent>
      </Card>

      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: space.sm }}>
        <Button type="button" disabled={saveMut.isPending} aria-busy={saveMut.isPending} onClick={() => saveMut.mutate(prefs)}>
          {saveMut.isPending ? '保存中…' : '保存设置'}
        </Button>
        {savedAt ? <Alert severity="success" role="status" sx={{ py: 0, '& .MuiAlert-message': { py: space.xs } }}>{savedAt} 已保存</Alert> : null}
        {saveMut.error ? <Alert severity="error">{(saveMut.error as Error).message}</Alert> : null}
      </Box>
    </Box>
  );
}
