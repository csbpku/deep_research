'use client';

import { useRef, useState } from 'react';
import { Archive, RotateCcw } from 'lucide-react';

import { AppButton as Button } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import Typography from '@mui/material/Typography';

export function ResearchStatusActionButton({
  researchId,
  title,
  status,
  compact = false,
  className,
  onChanged,
}: {
  researchId: string;
  title: string;
  status: 'published' | 'archived';
  compact?: boolean;
  className?: string;
  onChanged: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const action = status === 'published' ? 'archive' : 'restore';
  const label = action === 'archive' ? '归档' : '恢复';
  const isArchive = action === 'archive';

  async function run() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/researches/${researchId}/${action}`, {
        method: 'POST',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ message: '操作失败' })) as {
          message?: string;
        };
        throw new Error(payload.message ?? '操作失败');
      }
      // Keep the guard through query invalidation; close and re-enable in the
      // same render so the modal can restore focus to an enabled trigger.
      await onChanged();
      setOpen(false);
    } catch (runError) {
      setError(
        runError instanceof TypeError
          ? '网络请求失败，请稍后重试。'
          : runError instanceof Error
            ? runError.message
            : '操作失败',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outlined"
        color={isArchive ? 'error' : 'primary'}
        className={className}
        sx={compact ? { width: 'var(--dr-control-height)', padding: 0, flexShrink: 0 } : undefined}
        aria-label={`${label}：${title}`}
        title={compact ? label : undefined}
        disabled={pending}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {isArchive ? <Archive aria-hidden /> : <RotateCcw aria-hidden />}
        {compact ? null : label}
      </Button>

      <AppDialog open={open} onClose={() => { if (!pending) setOpen(false); }}
        title={isArchive ? '归档这份调研？' : '恢复这份调研？'}
        description={isArchive
                ? '归档后普通成员将无法访问，你仍可在“我的内容”中恢复。'
                : '恢复后重新对全部成员可见。'}
        initialFocusRef={cancelRef}
        actions={<>
            <Button ref={cancelRef} type="button" variant="outlined" onClick={() => setOpen(false)} disabled={pending}>
              取消
            </Button>
            <Button
              type="button"
              variant="contained" color={isArchive ? 'error' : 'primary'}
              onClick={() => void run()}
              disabled={pending}
            >
              {isArchive ? <Archive aria-hidden /> : <RotateCcw aria-hidden />}
              {pending ? '处理中…' : isArchive ? '确认归档' : '确认恢复'}
            </Button>
        </>}>
          <Typography component="p" sx={{ mb: 2, overflowWrap: 'anywhere' }}>调研：<strong>{title}</strong></Typography>
          {error ? <Typography component="p" color="error" role="alert">{error}</Typography> : null}
      </AppDialog>
    </>
  );
}
