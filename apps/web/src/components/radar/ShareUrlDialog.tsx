'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Link as LinkIcon } from 'lucide-react';

import { AppButton as Button } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { space, tokens } from '@deep-research/design-system';
import { ErrorState, LoadingState } from '@/components/StateMessage';

interface ShareItem {
  id: string;
  url: string;
  fetchedTitle: string | null;
  status: 'pending' | 'approved' | 'rejected';
  fetchErrorMessage: string | null;
  publishedSummaryId: string | null;
  createdAt: string;
}

const STATUS_LABEL: Record<ShareItem['status'], string> = {
  pending: '待审核',
  approved: '已收录',
  rejected: '未收录',
};

export function ShareUrlDialog() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const urlRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const history = useQuery<{ items: ShareItem[] }>({
    queryKey: ['my-share-submissions'],
    queryFn: async () => {
      const response = await fetch('/api/shares', { cache: 'no-store' });
      if (!response.ok) throw new Error('加载分享记录失败');
      return response.json();
    },
    enabled: open,
    refetchInterval: open ? 5_000 : false,
  });
  const submit = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), userNote: note.trim() || undefined }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 409) {
        throw new Error((body as { message?: string }).message ?? '提交失败');
      }
      return body;
    },
    onSuccess: () => {
      setUrl('');
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['my-share-submissions'] });
    },
  });

  const items = history.data?.items ?? [];
  return (
    <>
      <Button type="button" variant="contained" onClick={() => setOpen(true)}><LinkIcon />分享链接</Button>
      <AppDialog open={open} onClose={() => setOpen(false)} title="分享技术链接"
        initialFocusRef={urlRef}
        description="系统会安全抓取并生成摘要，管理员审核后才会出现在技术雷达。"
        actions={<>
          <Button type="button" variant="outlined" onClick={() => setOpen(false)}>关闭</Button>
          <Button type="button" variant="contained" disabled={!url.trim() || submit.isPending} loading={submit.isPending} onClick={() => submit.mutate()}>
            <LinkIcon aria-hidden />提交审核
          </Button>
        </>}
      >
        <Box sx={{ minWidth: 0, display: 'grid', gap: space.md, paddingTop: space.xs }}>
          <TextField fullWidth inputRef={urlRef} label="分享 URL"
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/technical-article"
            slotProps={{ htmlInput: { 'aria-label': '分享 URL' } }}
          />
          <TextField fullWidth multiline minRows={3} label="分享说明（可选）"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            slotProps={{ htmlInput: { maxLength: 500, 'aria-label': '分享说明' } }}
            placeholder="为什么值得关注（可选）"
          />
          {submit.error ? <ErrorState title="提交失败" description={submit.error.message} /> : null}
          {submit.isSuccess ? (
            <Typography role="status" variant="body1" color="success.main" sx={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
              <CheckCircle2 size={16} aria-hidden />已提交，可在下方查看处理状态。
            </Typography>
          ) : null}
          <Box component="section" aria-label="我的分享记录" sx={{ minWidth: 0 }}>
            <Typography component="h3" variant="fieldTitle" sx={{ marginBottom: space.sm }}>最近分享</Typography>
            {history.isLoading ? <LoadingState label="加载中…" /> : null}
            {history.isError ? <ErrorState title="分享记录加载失败" description={history.error.message} action={<Button onClick={() => void history.refetch()}>重试</Button>} /> : null}
            {!history.isLoading && !history.isError && items.length === 0 ? <Typography variant="body1" color="text.secondary">还没有分享记录。</Typography> : null}
            <Box component="ul" sx={{ maxHeight: '208px', minWidth: 0, display: 'grid', gap: space.sm, overflowY: 'auto', listStyle: 'none', padding: 0, margin: 0 }}>
              {items.map((item) => (
                <Box component="li" key={item.id} sx={{ minWidth: 0, border: 1, borderColor: 'divider', borderRadius: tokens['radius-small'], padding: space.sm }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
                    <Chip size="small" variant="outlined" label={STATUS_LABEL[item.status]} />
                    <Typography variant="metadata" noWrap sx={{ minWidth: 0, flex: 1, fontWeight: 500 }}>{item.fetchedTitle ?? item.url}</Typography>
                  </Box>
                  {item.fetchErrorMessage ? <Typography variant="metadata" color="error.main" component="p" sx={{ marginTop: space.xs, overflowWrap: 'anywhere' }}>{item.fetchErrorMessage}</Typography> : null}
                  {item.publishedSummaryId ? (
                    <Button component="a" href={`/radar/${item.publishedSummaryId}`} sx={{ marginTop: space.xs }}>
                      查看已收录内容
                    </Button>
                  ) : null}
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      </AppDialog>
    </>
  );
}
