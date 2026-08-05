'use client';

// P1-B：雷达主动添加候选 — Dialog (URL 链接 / 文件上传)。
//
// 设计：
//   - 单 Dialog 支持两种提交：URL（默认）或文件（multipart）。
//   - 提交后展示 submission 处理回执：状态机推进 + 错误码 + 重试入口。
//   - 使用 react-query 提交 + invalidate `radar-submissions` 列表。
//   - 文件大小、扩展名、MIME 由 BFF 二次校验；前端仅给基础提示。

import { useState, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileUp, Link as LinkIcon, Loader2, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';

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

const STATUS_TONE: Record<string, string> = {
  received: 'bg-muted text-muted-foreground',
  type_detected: 'bg-muted text-muted-foreground',
  extracting: 'bg-status-running-bg text-status-running-fg',
  scoring: 'bg-status-running-bg text-status-running-fg',
  enriching: 'bg-status-running-bg text-status-running-fg',
  completed: 'bg-status-succeeded-bg text-status-succeeded-fg',
  duplicate: 'bg-status-partial-bg text-status-partial-fg',
  failed: 'bg-status-failed-bg text-status-failed-fg',
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
      <Button type="button" onClick={() => setOpen(true)} variant="default" size="sm">
        <LinkIcon className="size-4" />
        添加候选
      </Button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="添加雷达候选"
        >
          <div
            className="w-full max-w-xl rounded-lg border border-border bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">添加雷达候选</h2>
              <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)}>
                关闭
              </Button>
            </header>

            <Tabs value={tab} onValueChange={(v) => setTab(v as 'url' | 'file')}>
              <TabsList>
                <TabsTrigger value="url">
                  <LinkIcon className="size-3" />
                  URL 链接
                </TabsTrigger>
                <TabsTrigger value="file">
                  <FileUp className="size-3" />
                  文件
                </TabsTrigger>
              </TabsList>

              <TabsContent value="url" className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  支持 GitHub 仓库 / Issue / PR / Release、arXiv、普通文章链接。
                </p>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  aria-label="候选 URL"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={!url || submitUrlMut.isPending}
                  onClick={() => submitUrlMut.mutate(url)}
                >
                  {submitUrlMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <LinkIcon className="size-4" />}
                  提交
                </Button>
              </TabsContent>

              <TabsContent value="file" className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  支持 PDF / Markdown / HTML / TXT；单文件 ≤ {MAX_FILE_MB} MB。
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_MIME}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-sm"
                  aria-label="候选文件"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={!file || submitFileMut.isPending}
                  onClick={() => file && submitFileMut.mutate(file)}
                >
                  {submitFileMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
                  上传
                </Button>
              </TabsContent>
            </Tabs>

            {error ? (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-destructive" role="alert">
                <AlertTriangle className="size-3" />
                {error}
              </p>
            ) : null}

            <SubmissionsHistory onRetry={(id) => retryMut.mutate(id)} retrying={retryMut.isPending} />
          </div>
        </div>
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
  if (q.isLoading) return <p className="mt-4 text-xs text-muted-foreground">加载中…</p>;
  if (items.length === 0) {
    return <p className="mt-4 text-xs text-muted-foreground">还没有提交记录。</p>;
  }

  return (
    <div className="mt-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">处理回执</h3>
      <ul className="grid list-none gap-2 p-0">
        {items.map((s) => {
          const label = s.detectedKind ?? s.canonicalUrl ?? s.rawInput;
          return (
            <li key={s.id} className="rounded border border-border bg-background p-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge className={STATUS_TONE[s.status] ?? 'bg-muted text-muted-foreground'}>
                  {STATUS_LABELS[s.status] ?? s.status}
                </Badge>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {s.id.slice(0, 8)}…
                </span>
                {s.status === 'completed' && s.summaryId ? (
                  <a
                    href={`/radar/${s.summaryId}`}
                    className="ml-auto inline-flex items-center gap-0.5 text-primary hover:underline"
                  >
                    <CheckCircle2 className="size-3" />
                    打开候选
                  </a>
                ) : null}
                {s.status === 'failed' ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="ml-auto"
                    disabled={retrying}
                    onClick={() => onRetry(s.id)}
                  >
                    <RotateCcw className="size-3" />
                    重试
                  </Button>
                ) : null}
              </div>
              <p className="mt-1 truncate text-foreground">{label}</p>
              {s.errorMessage ? (
                <p className="mt-0.5 text-destructive">{s.errorMessage}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
