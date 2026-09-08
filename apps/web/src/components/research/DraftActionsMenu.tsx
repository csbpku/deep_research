'use client';

import Link from 'next/link';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function DraftActionsMenu({
  researchId,
  title,
  onDeleted,
}: {
  researchId: string;
  title: string;
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={`打开草稿操作：${title}`}
            title="更多操作"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/researches/${researchId}/edit`}>
              <Pencil />
              编辑草稿
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={(event) => {
              event.preventDefault();
              setError(null);
              setOpen(true);
            }}
          >
            <Trash2 />
            删除草稿
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
