'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Link as LinkIcon, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm"><LinkIcon />分享链接</Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>分享技术链接</DialogTitle>
          <DialogDescription>
            系统会安全抓取并生成摘要，管理员审核后才会出现在技术雷达。
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3">
          <Input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/technical-article"
            aria-label="分享 URL"
          />
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            placeholder="为什么值得关注（可选）"
            aria-label="分享说明"
          />
          {submit.error ? <p role="alert" className="text-sm text-destructive">{submit.error.message}</p> : null}
          {submit.isSuccess ? (
            <p className="flex items-center gap-1.5 text-sm text-status-succeeded-fg">
              <CheckCircle2 className="size-4" />已提交，可在下方查看处理状态。
            </p>
          ) : null}
          <section aria-label="我的分享记录" className="min-w-0">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">最近分享</h3>
            {history.isLoading ? <p className="text-sm text-muted-foreground">加载中…</p> : null}
            {!history.isLoading && items.length === 0 ? <p className="text-sm text-muted-foreground">还没有分享记录。</p> : null}
            <ul className="max-h-52 min-w-0 space-y-2 overflow-y-auto">
              {items.map((item) => (
                <li key={item.id} className="min-w-0 rounded-md border border-border p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{STATUS_LABEL[item.status]}</Badge>
                    <span className="min-w-0 flex-1 truncate font-medium">{item.fetchedTitle ?? item.url}</span>
                  </div>
                  {item.fetchErrorMessage ? <p className="mt-1 min-w-0 break-words text-destructive">{item.fetchErrorMessage}</p> : null}
                  {item.publishedSummaryId ? (
                    <a className="mt-1 inline-block min-w-0 max-w-full truncate text-primary hover:underline" href={`/radar/${item.publishedSummaryId}`}>
                      查看已收录内容
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>关闭</Button>
          <Button type="button" disabled={!url.trim() || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? <Loader2 className="animate-spin" /> : <LinkIcon />}提交审核
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
