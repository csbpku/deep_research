'use client';

// P1-B：雷达主动添加候选 — Dialog (URL 链接 / 文件上传)。
//
// 设计：
//   - 单 Dialog 支持两种提交：URL（默认）或文件（multipart）。
//   - 提交后展示 submission 处理回执：状态机推进 + 错误码 + 重试入口。
//   - 使用 react-query 提交 + invalidate `radar-submissions` 列表。
//   - 文件大小、扩展名、MIME 由 BFF 二次校验；前端仅给基础提示。

import { useState, useRef } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileUp, Link as LinkIcon, RotateCcw } from 'lucide-react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';

import { AppButton } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import { AppTextField } from '@/components/material/AppTextField';

const ACCEPTED_MIME = 'application/pdf,text/markdown,text/x-markdown,text/html,text/plain,.pdf,.md,.markdown,.html,.htm,.txt';
const MAX_FILE_MB = 10;

interface Submission {
  id: string;
  status: string;
  detectedKind: string | null;
  canonicalUrl: string | null;
  contentSha256: string | null;
  rawInput: string;
  errorCode: string | null;
  errorMessage: string | null;
  summaryId: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface SubmissionsResponse {
  items: Submission[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

const STATUS_LABELS: Record<string, string> = {
  received: '已接收',
  type_detected: '类型已识别',
  extracting: '抓取中',
  scoring: '评分中',
  enriching: '深度解析中',
  completed: '完成',
  duplicate: '重复',
  failed: '失败',
};

const STATUS_COLOR: Record<string, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
  received: 'default',
  type_detected: 'default',
  extracting: 'info',
  scoring: 'info',
  enriching: 'info',
  completed: 'success',
  duplicate: 'warning',
  failed: 'error',
};

export function AddRadarCandidateDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'url' | 'file'>('url');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const submitUrlMut = useMutation({
    mutationFn: async (rawInput: string) => {
      const r = await fetch('/api/radar/submissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rawInput }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data as { message?: string }).message ?? '提交失败');
      return data as { ok: true; submission: Submission };
    },
    onSuccess: () => {
      setUrl('');
      queryClient.invalidateQueries({ queryKey: ['radar-submissions'] });
    },
  });

  const submitFileMut = useMutation({
    mutationFn: async (f: File) => {
      const fd = new FormData();
      fd.append('file', f);
      const r = await fetch('/api/radar/submissions/upload', { method: 'POST', body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data as { message?: string }).message ?? '上传失败');
      return data as { ok: true; submission: Submission };
    },
    onSuccess: () => {
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      queryClient.invalidateQueries({ queryKey: ['radar-submissions'] });
    },
  });

  const retryMut = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/admin/radar/submissions/${id}/retry`, { method: 'POST' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error((data as { message?: string }).message ?? '重试失败');
      }
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['radar-submissions'] }),
  });

  const error =
    submitUrlMut.error?.message ??
    submitFileMut.error?.message ??
    retryMut.error?.message ??
    null;

  return (
    <>
      <AppButton type="button" onClick={() => setOpen(true)} variant="contained" size="small" startIcon={<LinkIcon />}>
        添加内容
      </AppButton>
      {open ? (
        <AppDialog open onClose={() => setOpen(false)} title="添加雷达内容">
          <Stack spacing={2}>
            <Tabs value={tab} onChange={(_, value: 'url' | 'file') => setTab(value)} aria-label="添加内容类型">
              <Tab value="url" icon={<LinkIcon size={16} />} iconPosition="start" label="URL 链接" />
              <Tab value="file" icon={<FileUp size={16} />} iconPosition="start" label="文件" />
            </Tabs>

            {tab === 'url' ? (
              <Stack spacing={2}>
                <Typography variant="body2" color="text.secondary">
                  支持 GitHub 仓库 / Issue / PR / Release、arXiv、普通文章链接。
                </Typography>
                <AppTextField
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  aria-label="雷达内容 URL"
                />
                <AppButton
                  type="button"
                  size="small"
                  variant="contained"
                  disabled={!url || submitUrlMut.isPending}
                  startIcon={submitUrlMut.isPending ? <CircularProgress size={16} color="inherit" /> : <LinkIcon />}
                  onClick={() => submitUrlMut.mutate(url)}
                >
                  提交
                </AppButton>
              </Stack>
            ) : (
              <Stack spacing={2}>
                <Typography variant="body2" color="text.secondary">
                  支持 PDF / Markdown / HTML / TXT；单文件 ≤ {MAX_FILE_MB} MB。
                </Typography>
                <Box
                  component="input"
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_MIME}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  aria-label="雷达内容文件"
                  sx={{
                    width: '100%',
                    color: 'text.secondary',
                    font: 'inherit',
                    '&::file-selector-button': {
                      minHeight: 36,
                      mr: 1.5,
                      px: 1.5,
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 1,
                      bgcolor: 'background.paper',
                      color: 'text.primary',
                      font: 'inherit',
                      cursor: 'pointer',
                    },
                    '@media (pointer: coarse)': { '&::file-selector-button': { minHeight: 44 } },
                  }}
                />
                <AppButton
                  type="button"
                  size="small"
                  variant="contained"
                  disabled={!file || submitFileMut.isPending}
                  startIcon={submitFileMut.isPending ? <CircularProgress size={16} color="inherit" /> : <FileUp />}
                  onClick={() => file && submitFileMut.mutate(file)}
                >
                  上传
                </AppButton>
              </Stack>
            )}

            {error ? (
              <Alert severity="error" icon={<AlertTriangle size={18} />} role="alert">
                {error}
              </Alert>
            ) : null}

            <SubmissionsHistory onRetry={(id) => retryMut.mutate(id)} retrying={retryMut.isPending} />
          </Stack>
        </AppDialog>
      ) : null}
    </>
  );
}

function SubmissionsHistory({ onRetry, retrying }: { onRetry: (id: string) => void; retrying: boolean }) {
  const q = useQuery<SubmissionsResponse>({
    queryKey: ['radar-submissions'],
    queryFn: async () => {
      const r = await fetch('/api/radar/submissions?page=1', { cache: 'no-store' });
      if (!r.ok) throw new Error('加载提交历史失败');
      return r.json();
    },
    refetchInterval: 5_000, // 处理中轮询；完成/失败后由 onSuccess 触发
  });

  const items = q.data?.items ?? [];
  if (q.isLoading) return <Typography variant="metadata" color="text.secondary">加载中…</Typography>;
  if (items.length === 0) {
    return <Typography variant="metadata" color="text.secondary">还没有提交记录。</Typography>;
  }

  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="fieldTitle" component="h3" sx={{ mb: 1, color: 'text.secondary' }}>处理回执</Typography>
      <Stack component="ul" spacing={1} sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {items.map((s) => {
          const label = s.detectedKind ?? s.canonicalUrl ?? s.rawInput;
          return (
            <Paper component="li" key={s.id} variant="outlined" sx={{ p: 1.5, listStyle: 'none' }}>
              <Stack direction="row" useFlexGap spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Chip
                  size="small"
                  color={STATUS_COLOR[s.status] ?? 'default'}
                  label={STATUS_LABELS[s.status] ?? s.status}
                />
                <Typography variant="metadata" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                  {s.id.slice(0, 8)}…
                </Typography>
                {s.status === 'completed' && s.summaryId ? (
                  <AppButton
                    component={Link}
                    href={`/radar/${s.summaryId}`}
                    variant="text"
                    size="small"
                    sx={{ ml: 'auto' }}
                    startIcon={<CheckCircle2 />}
                  >
                    打开雷达内容
                  </AppButton>
                ) : null}
                {s.status === 'failed' ? (
                  <AppButton
                    type="button"
                    size="small"
                    variant="outlined"
                    sx={{ ml: 'auto' }}
                    disabled={retrying}
                    startIcon={<RotateCcw />}
                    onClick={() => onRetry(s.id)}
                  >
                    重试
                  </AppButton>
                ) : null}
              </Stack>
              <Typography variant="metadata" sx={{ mt: 0.5, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</Typography>
              {s.errorMessage ? (
                <Typography variant="metadata" color="error.main" sx={{ mt: 0.5, display: 'block' }}>{s.errorMessage}</Typography>
              ) : null}
            </Paper>
          );
        })}
      </Stack>
    </Box>
  );
}
