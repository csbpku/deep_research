'use client';

import { useState } from 'react';
import { Archive, RotateCcw } from 'lucide-react';

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
      setOpen(false);
      await onChanged();
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
        variant="outline"
        size={compact ? 'icon-sm' : 'sm'}
        className={cn(isArchive && 'text-destructive hover:text-destructive', className)}
        aria-label={`${label}：${title}`}
        title={compact ? label : undefined}
        disabled={pending}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {isArchive ? <Archive /> : <RotateCcw />}
        {compact ? null : label}
      </Button>

      <Dialog open={open} onOpenChange={(nextOpen) => !pending && setOpen(nextOpen)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isArchive ? '归档这份调研？' : '恢复这份调研？'}</DialogTitle>
            <DialogDescription>
              {isArchive
                ? '归档后普通成员将无法访问，你仍可在“我的内容”中恢复。'
                : '恢复后重新对全部成员可见。'}
              <br />
              调研：<strong className="font-medium text-foreground">{title}</strong>
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              取消
            </Button>
            <Button
              type="button"
              variant={isArchive ? 'destructive' : 'default'}
              onClick={() => void run()}
              disabled={pending}
            >
              {isArchive ? <Archive /> : <RotateCcw />}
              {pending ? '处理中…' : isArchive ? '确认归档' : '确认恢复'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
