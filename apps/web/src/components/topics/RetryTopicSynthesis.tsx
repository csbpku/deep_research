'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import { RefreshCw } from 'lucide-react';

import { AppButton as Button } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';

export function RetryTopicSynthesis({ slug }: { slug: string }) {
  const router = useRouter();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submitRetry() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/topics/${encodeURIComponent(slug)}/synthesis/retry`, {
        method: 'POST',
      });
      const body = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? '提交综述重试失败，请稍后再试。');

      setOpen(false);
      setNotice('已提交综述重试；生成完成后刷新专题即可查看。');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提交综述重试失败，请稍后再试。');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outlined"
        startIcon={<RefreshCw aria-hidden />}
        onClick={() => {
          setError(null);
          setNotice(null);
          setOpen(true);
        }}
      >
        重试综述
      </Button>
      {notice ? <Alert severity="success" role="status">{notice}</Alert> : null}
      <AppDialog
        open={open}
        onClose={() => { if (!pending) setOpen(false); }}
        title="重新生成专题综述"
        description="确认后会将当前综述标记为待重试，由后台任务生成；这不会立即显示新内容。"
        initialFocusRef={cancelRef}
        actions={(
          <>
            <Button
              ref={cancelRef}
              type="button"
              variant="outlined"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              暂不重试
            </Button>
            <Button
              type="button"
              variant="contained"
              disabled={pending}
              aria-busy={pending}
              startIcon={pending ? <CircularProgress size={16} color="inherit" aria-hidden /> : <RefreshCw aria-hidden />}
              onClick={() => void submitRetry()}
            >
              {pending ? '提交中…' : '确认重试'}
            </Button>
          </>
        )}
      >
        {error ? <Alert severity="error" role="alert">{error}</Alert> : null}
      </AppDialog>
    </>
  );
}
