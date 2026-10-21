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
// 来源：docs/archive/2026-09-08-agent-prompts/week4-engineer-a.md §任务 1
//
// UI 使用共享 AppDialog / MUI Dialog，焦点陷阱、ESC 与滚动锁由 MUI 提供。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, UploadCloud } from 'lucide-react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';

import { MarkdownPreview } from './MarkdownPreview';
import { AppButton as Button } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';

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
  /* 轮询已开始时间(用于"已等待 X 秒"提示 + 30s 后的黄色警告) */
  const [pollingStartedAt, setPollingStartedAt] = useState<number>(0);
  const [now, setNow] = useState<number>(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadline = useRef<number>(0);

  // 清轮询
  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  /* 轮询期间 1Hz tick 计时,超 30s 黄色提示 */
  useEffect(() => {
    if (phase !== 'polling') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

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
        setPollingStartedAt(Date.now());
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
    /* 跳到编辑器而非只读详情 —— 导入后用户预期继续编辑 */
    if (job?.outputResearchId) {
      router.push(`/researches/${job.outputResearchId}/edit`);
    }
  }, [job, router]);

  return (
    <AppDialog
      open
      onClose={onClose}
      title="从文件导入"
      actions={phase === 'succeeded' ? (
        <>
          <Button type="button" variant="outlined" onClick={onClose}>关闭</Button>
          {job?.outputResearchId ? <Button type="button" onClick={handleViewDraft}>查看个人草稿</Button> : null}
        </>
      ) : phase === 'failed' ? (
        <>
          <Button type="button" variant="outlined" onClick={onClose}>关闭</Button>
          <Button type="button" onClick={handleRetry}>重试</Button>
        </>
      ) : null}
    >
        {/* 拖拽区 —— 键盘可达(Enter/Space 触发文件选择),role="button" + tabIndex */}
        {phase === 'idle' && (
          <Box
            role="button"
            tabIndex={0}
            aria-label="选择要导入的文件（也可拖入）"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            sx={{
              cursor: 'pointer',
              border: '2px dashed',
              borderColor: dragOver ? 'primary.main' : 'divider',
              borderRadius: 'var(--dr-radius-medium)',
              bgcolor: dragOver ? 'action.selected' : 'background.paper',
              px: 3,
              py: 5,
              textAlign: 'center',
              transition: 'border-color var(--dr-motion-fast), background-color var(--dr-motion-fast)',
              '&:hover': { bgcolor: 'action.hover', borderColor: 'primary.main' },
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".md,.txt,.html"
              onChange={handleInputChange}
              style={{ display: 'none' }}
            />
            <Box aria-hidden="true" sx={{ display: 'flex', justifyContent: 'center', color: 'primary.main', '& svg': { width: 24, height: 24 } }}>
              <UploadCloud />
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              拖拽 .md / .txt / .html 文件到此处
              <br />
              或点击选择文件
            </Typography>
            <Typography variant="metadata" color="text.secondary" component="p" sx={{ mt: 1 }}>单文件 ≤ 5MB</Typography>
          </Box>
        )}

        {/* 上传中 / 轮询中 */}
        {(phase === 'uploading' || phase === 'polling') && (
          <Box role="status" aria-live="polite">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
              <CircularProgress size={18} aria-label={phase === 'uploading' ? '上传中' : '转换中'} />
              <Typography variant="control" color="text.secondary">
                {phase === 'uploading'
                  ? '上传中…'
                  : `转换中…${job ? ` (${job.status})` : ''} · 已等待 ${Math.max(1, Math.round((now - pollingStartedAt) / 1000))} 秒`}
              </Typography>
            </Box>
            <ProgressBar />
            {phase === 'polling' && now - pollingStartedAt > 30_000 ? (
              <Alert severity="warning" sx={{ mt: 1.5, py: 0.25 }}>
                已等待超过 30 秒,通常是文档较大或外部 LLM 排队;任务仍在后台,可关闭对话框稍后回来。
              </Alert>
            ) : null}
            {job?.filename && (
              <Typography variant="metadata" component="p" color="text.secondary" sx={{ mt: 1.5, fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{job.filename}</Typography>
            )}
          </Box>
        )}

        {/* 成功 */}
        {phase === 'succeeded' && job && (
          <Box>
            <Alert severity="success" icon={<CheckCircle2 size={18} />} sx={{ mb: 1.5 }}>
              转换成功！{job.outputResearchId ? '已生成个人草稿。' : ''}
            </Alert>

            {Array.isArray(job.warnings) && job.warnings.length > 0 ? (
              <Alert severity="warning" sx={{ mb: 1.5 }}>
                <Typography variant="control" component="h3" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, fontWeight: 600 }}>
                  <AlertTriangle size={16} aria-hidden="true" />
                  转换告警 ({job.warnings.length})
                </Typography>
                <Box component="ul" sx={{ mt: 0.5, mb: 0, pl: 2.5, typography: 'metadata', '& li + li': { mt: 0.5 } }}>
                  {(job.warnings as unknown[]).map((w, i) => (
                    <li key={i}>{String(w)}</li>
                  ))}
                </Box>
              </Alert>
            ) : (
              <Typography variant="metadata" component="p" color="text.secondary" sx={{ mb: 1.5 }}>无警告</Typography>
            )}

            {draftBody !== null && (
              <Box sx={{ mb: 1.5 }}>
                <Typography variant="metadata" component="h3" color="text.secondary" sx={{ mb: 0.5, fontWeight: 600 }}>
                  Markdown 预览
                </Typography>
                <MarkdownPreview source={draftBody} />
              </Box>
            )}
          </Box>
        )}

        {/* 失败 */}
        {phase === 'failed' && (
          <Box>
            <Alert severity="error" role="alert" sx={{ mb: 1.5 }}>
              {error ?? job?.errorMessage ?? '导入失败'}
            </Alert>
            {job?.errorCode && (
              <Typography variant="metadata" component="p" color="text.secondary" sx={{ mb: 1.5, fontFamily: 'monospace' }}>
                错误码: {job.errorCode}
              </Typography>
            )}
          </Box>
        )}

        {/* idle 状态下显示错误 */}
        {phase === 'idle' && error && (
          <Alert role="alert" severity="error" sx={{ mt: 1.5 }}>
            {error}
          </Alert>
        )}
    </AppDialog>
  );
}

/** 不定长进度条 —— 转换耗时未知，只表达「在动」。 */
function ProgressBar() {
  return <LinearProgress variant="indeterminate" aria-label="文件转换进度" sx={{ height: 4, borderRadius: 'var(--dr-radius-pill)' }} />;
}
