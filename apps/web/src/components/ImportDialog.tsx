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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MarkdownPreview } from './MarkdownPreview.js';

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
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 12,
          padding: 24,
          width: 640,
          maxWidth: '90vw',
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>从文件导入</h2>
          <button
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: 20,
              color: '#94a3b8',
            }}
          >
            ×
          </button>
        </div>

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
            style={{
              border: `2px dashed ${dragOver ? '#0f172a' : '#cbd5e1'}`,
              borderRadius: 8,
              padding: 40,
              textAlign: 'center',
              cursor: 'pointer',
              background: dragOver ? '#f8fafc' : '#fff',
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".md,.txt,.html"
              onChange={handleInputChange}
              style={{ display: 'none' }}
            />
            <p style={{ margin: 0, fontSize: 14, color: '#475569' }}>
              拖拽 .md / .txt / .html 文件到此处
              <br />
              或点击选择文件
            </p>
            <p style={{ margin: '8px 0 0', fontSize: 12, color: '#94a3b8' }}>
              单文件 ≤ 5MB
            </p>
          </div>
        )}

        {/* 上传中 / 轮询中 */}
        {(phase === 'uploading' || phase === 'polling') && job && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <Spinner />
              <span style={{ fontSize: 14, color: '#475569' }}>
                {phase === 'uploading' ? '上传中...' : `转换中... (${job.status})`}
              </span>
            </div>
            <ProgressBar />
            {job.filename && (
              <p style={{ fontSize: 12, color: '#94a3b8', margin: '8px 0 0' }}>
                {job.filename}
              </p>
            )}
          </div>
        )}

        {/* 成功 */}
        {phase === 'succeeded' && job && (
          <div>
            <div style={{
              border: '1px solid #bbf7d0',
              background: '#f0fdf4',
              color: '#15803d',
              padding: 12,
              borderRadius: 6,
              marginBottom: 12,
              fontSize: 13,
            }}>
              转换成功！{job.outputResearchId ? '已生成个人草稿。' : ''}
            </div>

            {Array.isArray(job.warnings) && job.warnings.length > 0 ? (
              <div style={{ marginBottom: 12 }}>
                <h3 style={{ fontSize: 13, color: '#92400e', margin: '0 0 4px' }}>
                  转换告警 ({job.warnings.length})
                </h3>
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: '#92400e' }}>
                  {(job.warnings as unknown[]).map((w, i) => (
                    <li key={i}>{String(w)}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 12px' }}>无警告</p>
            )}

            {draftBody !== null && (
              <div style={{ marginBottom: 12 }}>
                <h3 style={{ fontSize: 13, color: '#475569', margin: '0 0 4px' }}>
                  Markdown 预览
                </h3>
                <MarkdownPreview source={draftBody} />
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={onClose}
                style={{
                  padding: '8px 14px',
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  background: '#fff',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                关闭
              </button>
              {job.outputResearchId && (
                <button
                  onClick={handleViewDraft}
                  style={{
                    padding: '8px 16px',
                    border: 'none',
                    borderRadius: 6,
                    background: '#0f172a',
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                >
                  查看个人草稿
                </button>
              )}
            </div>
          </div>
        )}

        {/* 失败 */}
        {phase === 'failed' && (
          <div>
            <div style={{
              border: '1px solid #fecaca',
              background: '#fef2f2',
              color: '#dc2626',
              padding: 12,
              borderRadius: 6,
              marginBottom: 12,
              fontSize: 13,
            }}>
              {error ?? job?.errorMessage ?? '导入失败'}
            </div>
            {job?.errorCode && (
              <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 12px' }}>
                错误码: {job.errorCode}
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={onClose}
                style={{
                  padding: '8px 14px',
                  border: '1px solid #e2e8f0',
                  borderRadius: 6,
                  background: '#fff',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                关闭
              </button>
              <button
                onClick={handleRetry}
                style={{
                  padding: '8px 16px',
                  border: 'none',
                  borderRadius: 6,
                  background: '#0f172a',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                重试
              </button>
            </div>
          </div>
        )}

        {/* idle 状态下显示错误 */}
        {phase === 'idle' && error && (
          <div style={{
            border: '1px solid #fecaca',
            background: '#fef2f2',
            color: '#dc2626',
            padding: 12,
            borderRadius: 6,
            marginTop: 12,
            fontSize: 13,
          }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      style={{
        width: 16,
        height: 16,
        border: '2px solid #e2e8f0',
        borderTopColor: '#0f172a',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
        display: 'inline-block',
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

function ProgressBar() {
  return (
    <div style={{
      width: '100%',
      height: 4,
      background: '#e2e8f0',
      borderRadius: 2,
      overflow: 'hidden',
    }}>
      <div style={{
        width: '40%',
        height: '100%',
        background: '#0f172a',
        animation: 'progress 1.5s ease-in-out infinite',
      }}>
        <style>{`@keyframes progress { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }`}</style>
      </div>
    </div>
  );
}