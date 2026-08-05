'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

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
      <Button
        type="button"
        variant={compact ? 'ghost' : 'outline'}
        size={compact ? 'icon-sm' : 'sm'}
        className={cn('text-destructive hover:text-destructive', className)}
        aria-label={`删除草稿：${title}`}
        title={compact ? '删除草稿' : undefined}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Trash2 />
        {compact ? null : '删除草稿'}
      </Button>

      <Dialog open={open} onOpenChange={(nextOpen) => !deleting && setOpen(nextOpen)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>永久删除这份草稿？</DialogTitle>
            <DialogDescription>
              “{title}”及其挂载资料会被删除，此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={deleting}>
              取消
            </Button>
            <Button type="button" variant="destructive" onClick={() => void deleteDraft()} disabled={deleting}>
              <Trash2 />
              {deleting ? '删除中…' : '永久删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
