'use client';

import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import Typography from '@mui/material/Typography';

import { AppButton as Button, AppIconButton } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';

export function DeleteDraftButton({
  researchId,
  title,
  compact = false,
  className,
  onDeleted,
}: {
  researchId: string;
  title: string;
  compact?: boolean;
  className?: string;
  onDeleted: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function deleteDraft() {
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/researches/${researchId}`, { method: 'DELETE' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ message: '删除失败' })) as {
          message?: string;
        };
        throw new Error(payload.message ?? '删除失败');
      }
      setOpen(false);
      await onDeleted();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      {compact ? (
        <AppIconButton
          type="button"
          color="error"
          className={className}
          aria-label={`删除草稿：${title}`}
          title="删除草稿"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          <Trash2 size={16} aria-hidden="true" />
        </AppIconButton>
      ) : (
        <Button
          type="button"
          variant="outlined"
          color="error"
          size="small"
          className={className}
          aria-label={`删除草稿：${title}`}
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
          startIcon={<Trash2 aria-hidden="true" />}
        >
          删除草稿
        </Button>
      )}

      <AppDialog
        open={open}
        onClose={() => { if (!deleting) setOpen(false); }}
        title="永久删除这份草稿？"
        description={`“${title}”及其挂载资料会被删除，此操作无法撤销。`}
        initialFocusRef={cancelRef}
        actions={(
          <>
            <Button ref={cancelRef} type="button" variant="outlined" onClick={() => setOpen(false)} disabled={deleting}>
              取消
            </Button>
            <Button
              type="button"
              variant="contained"
              color="error"
              onClick={() => void deleteDraft()}
              disabled={deleting}
              startIcon={<Trash2 aria-hidden="true" />}
            >
              {deleting ? '删除中…' : '永久删除'}
            </Button>
          </>
        )}
      >
        {error ? <Typography component="p" color="error" role="alert">{error}</Typography> : null}
      </AppDialog>
    </>
  );
}
