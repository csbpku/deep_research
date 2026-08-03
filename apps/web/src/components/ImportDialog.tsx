'use client';

// ImportDialog —— 文件导入弹窗。
//
// 行为：
//   1. 拖拽 + 点击选择 .md / .txt / .html 文件
//   2. 前端预校验扩展名 + MIME
//   3. POST /api/imports (multipart/form-data)
//   4. 成功后立即轮询 GET /api/imports/[id]，每 2 秒一次
//   5. 60 秒超时切到"后台仍在运行"提示
//   6. 三态展示：
//      - queued/running：进度条 + spinner
//      - succeeded：warnings 列表 + Markdown 预览 + "查看个人草稿"按钮
//      - failed：errorCode + errorMessage + "重试" 按钮
//   7. 调用方权限不足（401/403）→ router.push('/signin')
//
// 来源：docs/agent-prompts/week4-engineer-a.md §任务 1
//
// UI 重设计后：弹窗改用 shadcn Dialog（Radix），焦点陷阱 / ESC / 滚动锁
// 由 Radix 提供，不再手写 overlay + stopPropagation。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Loader2, UploadCloud } from 'lucide-react';

import { MarkdownPreview } from './MarkdownPreview';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Phase = 'idle' | 'uploading' | 'polling' | 'succeeded' | 'failed';

interface ImportJob {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  warnings: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  outputResearchId: string | null;
  createdAt: string;
  completedAt: string | null;
}

const ALLOWED_EXTENSIONS = ['.md', '.txt', '.html'] as const;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [job, setJob] = useState<ImportJob | null>(null);
  const [draftBody, setDraftBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadline = useRef<number>(0);

  // 清轮询
  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);

      // 前端预校验扩展名
      const dot = file.name.lastIndexOf('.');
      const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
      if (!ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
        setError(`不支持的文件后缀: ${ext || '(无)'}。仅允许 .md / .txt / .html`);
        return;
      }

      setPhase('uploading');

      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/imports', { method: 'POST', body: fd });
        if (res.status === 401 || res.status === 403) {
          router.push('/signin');
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? `HTTP ${res.status}`);
        }
        const data: ImportJob = await res.json();
        setJob(data);
        setPhase('polling');
        pollDeadline.current = Date.now() + POLL_TIMEOUT_MS;
        schedulePoll(data.jobId);
      } catch (e) {
        setError(e instanceof Error ? e.message : '上传失败');
        setPhase('failed');
      }
    },
    [router],
  );

  const schedulePoll = useCallback((jobId: string) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(() => void pollOnce(jobId), POLL_INTERVAL_MS);
  }, []);

  const pollOnce = useCallback(
    async (jobId: string) => {
      if (Date.now() > pollDeadline.current) {
        setError('轮询超时，但任务仍在后台运行。可在「导入历史」中查看。');
        setPhase('failed');
        return;
      }
      try {
        const res = await fetch(`/api/imports/${jobId}`);
        if (!res.ok) {
          // 401/403 → signin
          if (res.status === 401 || res.status === 403) {
            router.push('/signin');
            return;
          }
          // 其他错误：下一轮再试
          schedulePoll(jobId);
          return;
        }
        const data: ImportJob = await res.json();
        setJob(data);
        if (data.status === 'succeeded') {
          setPhase('succeeded');
          // 拉取草稿正文做预览
          if (data.outputResearchId) {
            const r = await fetch(`/api/researches/${data.outputResearchId}`);
            if (r.ok) {
              const detail = await r.json();
              setDraftBody(detail.body ?? '');
            }
          }
          return;
        }
        if (data.status === 'failed' || data.status === 'cancelled') {
          setPhase('failed');
          return;
        }
        // 仍 queued/running → 继续轮询
        schedulePoll(jobId);
      } catch (e) {
        // 网络错误：继续下一轮
        schedulePoll(jobId);
      }
    },
    [router, schedulePoll],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      e.target.value = '';
    },
    [handleFile],
  );

  const handleRetry = useCallback(() => {
    setPhase('idle');
    setJob(null);
    setError(null);
    setDraftBody(null);
    inputRef.current?.click();
  }, []);

  const handleViewDraft = useCallback(() => {
    if (job?.outputResearchId) {
      router.push(`/researches/${job.outputResearchId}`);
    }
  }, [job, router]);

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>从文件导入</DialogTitle>
        </DialogHeader>

        {/* 拖拽区 */}
        {phase === 'idle' && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            className={cn(
              'cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors duration-200',
              dragOver ? 'border-primary bg-accent/40' : 'border-border bg-card hover:bg-muted/40',
            )}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".md,.txt,.html"
              onChange={handleInputChange}
              className="hidden"
            />
            <UploadCloud className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              拖拽 .md / .txt / .html 文件到此处
              <br />
              或点击选择文件
            </p>
            <p className="mt-2 text-xs text-muted-foreground">单文件 ≤ 5MB</p>
          </div>
        )}

        {/* 上传中 / 轮询中 */}
        {(phase === 'uploading' || phase === 'polling') && job && (
          <div>
            <div className="mb-3 flex items-center gap-3">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">
                {phase === 'uploading' ? '上传中…' : `转换中… (${job.status})`}
              </span>
            </div>
            <ProgressBar />
            {job.filename && (
              <p className="mt-2 font-mono text-xs text-muted-foreground">{job.filename}</p>
            )}
          </div>
        )}

        {/* 成功 */}
        {phase === 'succeeded' && job && (
          <div>
            <div className="mb-3 flex items-center gap-2 rounded-md bg-status-succeeded-bg p-3 text-sm text-status-succeeded-fg">
              <CheckCircle2 className="size-4 shrink-0" />
              转换成功！{job.outputResearchId ? '已生成个人草稿。' : ''}
            </div>

            {Array.isArray(job.warnings) && job.warnings.length > 0 ? (
              <div className="mb-3 rounded-md bg-status-partial-bg p-3 text-status-partial-fg">
                <h3 className="flex items-center gap-1.5 text-sm font-medium">
                  <AlertTriangle className="size-3.5" />
                  转换告警 ({job.warnings.length})
                </h3>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                  {(job.warnings as unknown[]).map((w, i) => (
                    <li key={i}>{String(w)}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mb-3 text-xs text-muted-foreground">无警告</p>
            )}

            {draftBody !== null && (
              <div className="mb-3">
                <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Markdown 预览
                </h3>
                <MarkdownPreview source={draftBody} />
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                关闭
              </Button>
              {job.outputResearchId && (
                <Button type="button" onClick={handleViewDraft}>
                  查看个人草稿
                </Button>
              )}
            </div>
          </div>
        )}

        {/* 失败 */}
        {phase === 'failed' && (
          <div>
            <div
              role="alert"
              className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error ?? job?.errorMessage ?? '导入失败'}
            </div>
            {job?.errorCode && (
              <p className="mb-3 font-mono text-xs text-muted-foreground">
                错误码: {job.errorCode}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                关闭
              </Button>
              <Button type="button" onClick={handleRetry}>
                重试
              </Button>
            </div>
          </div>
        )}

        {/* idle 状态下显示错误 */}
        {phase === 'idle' && error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 不定长进度条 —— 转换耗时未知，只表达「在动」。 */
function ProgressBar() {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full w-1/4 animate-indeterminate-bar rounded-full bg-primary" />
    </div>
  );
}
