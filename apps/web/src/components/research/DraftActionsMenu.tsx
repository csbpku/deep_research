'use client';

import Link from 'next/link';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import { AppButton as Button, AppIconButton } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';

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
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

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
      await onDeleted();
      setOpen(false);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
          <AppIconButton ref={triggerRef}
            type="button"
            sx={{ flexShrink: 0, color: 'text.secondary' }}
            aria-label={`打开草稿操作：${title}`}
            title="更多操作"
            id={`${menuId}-trigger`} aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)}
            aria-controls={menuAnchor ? menuId : undefined} onClick={event => setMenuAnchor(event.currentTarget)}
          >
            <MoreHorizontal size={16} aria-hidden />
          </AppIconButton>
        <Menu id={menuId} anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}
          disableRestoreFocus={open}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          slotProps={{ paper: { className: 'material-surface' }, list: { 'aria-labelledby': `${menuId}-trigger` } }}>
          <MenuItem component={Link} href={`/researches/${researchId}/edit`} onClick={() => setMenuAnchor(null)}>
              <Pencil size={16} aria-hidden style={{ marginRight: 'var(--dr-space-2)' }} />编辑草稿
          </MenuItem>
          <Divider />
          <MenuItem sx={{ color: 'error.main' }}
            onClick={() => {
              setMenuAnchor(null);
              // The menu item unmounts. Let the dialog restore to the stable trigger.
              triggerRef.current?.focus();
              setError(null);
              setOpen(true);
            }}
          >
            <Trash2 size={16} aria-hidden style={{ marginRight: 'var(--dr-space-2)' }} />删除草稿
          </MenuItem>
        </Menu>

      <AppDialog open={open} onClose={() => { if (!deleting) setOpen(false); }}
        title="永久删除这份草稿？" description={`“${title}”及其挂载资料会被删除，此操作无法撤销。`}
        initialFocusRef={cancelRef}
        actions={<>
            <Button ref={cancelRef} type="button" variant="outlined" onClick={() => setOpen(false)} disabled={deleting}>
              取消
            </Button>
            <Button type="button" variant="contained" color="error" onClick={() => void deleteDraft()} disabled={deleting}>
              <Trash2 aria-hidden />
              {deleting ? '删除中…' : '永久删除'}
            </Button>
        </>}>
          {error ? <Typography component="p" color="error" role="alert">{error}</Typography> : null}
      </AppDialog>
    </>
  );
}
