'use client';

// AdminActionDialog —— 替换 admin 流程里的 prompt() / 直接确认。
//
// 解决的问题：
//   - window.prompt() 样式与平台不一致，移动端体验糟糕，且无法支持多字段。
//   - 破坏性操作直接 confirm() 一行字，体验弱，且不能要求填写理由。
//
// 设计：
//   - 单一 Dialog：根据 config 渲染一组输入项（text / textarea / 静态值）。
//   - 提交回调 onSubmit(values) 由父组件持有，本组件只负责收集 + 校验。
//   - 校验失败时按钮 disabled，避免误触发。
//
// 用法：
//   const [target, setTarget] = useState<...|null>(null);
//   <AdminActionDialog
//     open={!!target}
//     onOpenChange={(o) => !o && setTarget(null)}
//     title="拒绝分享"
//     description="请说明拒绝原因，提交者会收到。"
//     fields={[{ id: 'reason', label: '原因', required: true, multiline: true, defaultValue: '内容与平台无关' }]}
//     onSubmit={(values) => api.reject(target!.id, values)}
//   />

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { Eye, Pencil, X } from 'lucide-react';

import { AppButton as Button, AppIconButton } from '@/components/material/AppButton';
import { AppDialog } from '@/components/material/AppDialog';
import { AppTextField } from '@/components/material/AppTextField';

const MarkdownContent = dynamic(() => import('@/components/MarkdownContent'), {
  ssr: false,
  loading: () => <Skeleton variant="rounded" height={220} />,
});

export type AdminActionField =
  | {
      kind: 'text';
      id: string;
      label: string;
      placeholder?: string;
      defaultValue?: string;
      required?: boolean;
      maxLength?: number;
    }
  | {
      kind: 'textarea';
      id: string;
      label: string;
      placeholder?: string;
      defaultValue?: string;
      required?: boolean;
      maxLength?: number;
      rows?: number;
    }
  | {
      /** Markdown 编辑器（双视图：write / preview），用于「提炼精华 body」等需要预览的场景 */
      kind: 'markdown';
      id: string;
      label: string;
      placeholder?: string;
      defaultValue?: string;
      required?: boolean;
      maxLength?: number;
      /** 编辑器高度（行数）；含 toolbar + preview 切换 */
      rows?: number;
    }
  | {
      /** 标签 chips 输入（Enter / , 添加，单击 × 删除） */
      kind: 'tags';
      id: string;
      label: string;
      placeholder?: string;
      defaultValue?: string[];
      /** 每个 tag 最大长度；超过会被截断 */
      maxTagLength?: number;
      /** tag 最大数量；超过阻止继续添加 */
      maxTags?: number;
    }
  | {
      kind: 'static';
      id: string;
      label: string;
      /** 静态展示一段上下文（如「分享人：xxx」「评论原文：…」） */
      value: string;
    };

export type AdminActionValues = Record<string, string | string[]>;

function MarkdownEditor({
  id,
  value,
  onChange,
  placeholder,
  maxLength,
  rows,
  focusRef,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  rows: number;
  focusRef?: (element: HTMLElement | null) => void;
}) {
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  return (
    <Box sx={{ overflow: 'hidden', border: 1, borderColor: 'divider', borderRadius: 'var(--dr-radius-medium)' }}>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', borderBottom: 1, borderColor: 'divider', bgcolor: 'action.hover', p: 0.5 }}>
        <Box sx={{ display: 'inline-flex', border: 1, borderColor: 'divider', bgcolor: 'background.paper', borderRadius: 'var(--dr-radius-small)', p: 0.5 }} role="group" aria-label="正文视图">
          <Button type="button" variant="text" sx={{ bgcolor: mode === 'write' ? 'action.selected' : 'transparent', color: 'text.primary' }} onClick={() => setMode('write')} startIcon={<Pencil aria-hidden="true" />}>
            编辑
          </Button>
          <Button type="button" variant="text" sx={{ bgcolor: mode === 'preview' ? 'action.selected' : 'transparent', color: 'text.primary' }} onClick={() => setMode('preview')} startIcon={<Eye aria-hidden="true" />}>
            预览
          </Button>
        </Box>
      </Box>
      {mode === 'write' ? (
        <TextField
          id={id}
          inputRef={focusRef}
          fullWidth
          multiline
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          slotProps={{ htmlInput: { maxLength } }}
          sx={{ '& .MuiInputBase-root': { borderRadius: 0 }, '& .MuiInputBase-inputMultiline': { resize: 'vertical' } }}
        />
      ) : (
        <Box sx={{ minHeight: 220, overflow: 'auto', px: 1.5, py: 1 }}><MarkdownContent content={value || '_（暂无内容）_'} compact /></Box>
      )}
    </Box>
  );
}

function TagsInput({
  id,
  value,
  onChange,
  placeholder,
  maxTagLength = 40,
  maxTags = 10,
  focusRef,
}: {
  id: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  maxTagLength?: number;
  maxTags?: number;
  focusRef?: (element: HTMLElement | null) => void;
}) {
  const [pending, setPending] = useState('');
  const commit = () => {
    const tag = pending.trim().replace(/,+$/u, '').slice(0, maxTagLength);
    if (!tag || value.includes(tag) || value.length >= maxTags) { setPending(''); return; }
    onChange([...value, tag]); setPending('');
  };
  return (
    <Box sx={{ display: 'grid', gap: 1 }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {value.map((tag) => (
          <Box key={tag} component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, border: 1, borderColor: 'divider', borderRadius: 'var(--dr-radius-pill)', bgcolor: 'action.hover', pl: 1, pr: 0.5, py: 0.25 }}>
            <Typography component="span" variant="metadata">{tag}</Typography>
            <AppIconButton
              type="button"
              size="small"
              onClick={() => onChange(value.filter((v) => v !== tag))}
              aria-label={`移除标签 ${tag}`}
              sx={{
                width: 24, minWidth: 24, height: 24, minHeight: 24, p: 0.25,
                '@media (pointer: coarse)': { width: 'var(--dr-touch-target)', minWidth: 'var(--dr-touch-target)', height: 'var(--dr-touch-target)', minHeight: 'var(--dr-touch-target)' },
              }}
            >
              <X size={14} aria-hidden="true" />
            </AppIconButton>
          </Box>
        ))}
      </Box>
      <AppTextField
        ref={focusRef}
        id={id}
        value={pending}
        placeholder={placeholder ?? '输入标签后按 Enter'}
        onChange={(e) => { const next = e.target.value; if (next.endsWith(',')) { setPending(next.slice(0, -1)); requestAnimationFrame(commit); } else setPending(next); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } }}
        disabled={value.length >= maxTags}
      />
      <input type="hidden" value={value.join(',')} readOnly />
      <Typography variant="metadata" color="text.secondary">最多 {maxTags} 个，每个不超过 {maxTagLength} 字</Typography>
    </Box>
  );
}

export function AdminActionDialog({
  open,
  onOpenChange,
  title,
  description,
  fields,
  confirmLabel,
  cancelLabel = '取消',
  destructive = false,
  pending = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  fields: AdminActionField[];
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onSubmit: (values: AdminActionValues) => void | Promise<void>;
}) {
  const [values, setValues] = useState<AdminActionValues>({});
  const initialFocusRef = useRef<HTMLElement | null>(null);
  const firstFocusableFieldId = fields.find((field) => (
    field.kind !== 'static'
    && !(field.kind === 'tags' && (field.defaultValue ?? []).length >= (field.maxTags ?? 10))
  ))?.id;
  const captureInitialFocus = (element: HTMLElement | null) => {
    initialFocusRef.current = element;
  };

  // open 切换：重置或填入默认值
  useEffect(() => {
    if (!open) return;
    const next: AdminActionValues = {};
    for (const f of fields) {
      if (f.kind === 'static') continue;
      if (f.kind === 'tags') {
        next[f.id] = f.defaultValue ?? [];
        continue;
      }
      next[f.id] = f.defaultValue ?? '';
    }
    setValues(next);
  }, [open, fields]);

  const valid = useMemo(() => {
    for (const f of fields) {
      if (f.kind === 'static') continue;
      if (f.kind === 'tags') {
        // tags 字段没有 required 概念；至少 1 个 tag 由调用方控制
        continue;
      }
      const v = String(values[f.id] ?? '').trim();
      if (f.required && !v) return false;
    }
    return true;
  }, [fields, values]);

  return (
    <AppDialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={title}
      description={description}
      initialFocusRef={initialFocusRef}
      actions={(
        <>
          <Button ref={firstFocusableFieldId ? undefined : (element) => captureInitialFocus(element)} type="button" variant="outlined" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="contained"
            color={destructive ? 'error' : 'primary'}
            disabled={!valid || pending}
            onClick={() => void onSubmit(values)}
          >
            {pending ? '提交中…' : confirmLabel}
          </Button>
        </>
      )}
    >
      <Box sx={{ display: 'grid', gap: 1.5 }}>
          {fields.map((f) => {
            const focusRef = f.id === firstFocusableFieldId ? captureInitialFocus : undefined;
            if (f.kind === 'static') {
              return (
                <Box key={f.id} sx={{ display: 'grid', gap: 0.5 }}>
                  <Typography variant="metadata" color="text.secondary" sx={{ fontWeight: 500 }}>{f.label}</Typography>
                  <Typography component="p" variant="body2" sx={{ border: 1, borderColor: 'divider', borderRadius: 'var(--dr-radius-medium)', bgcolor: 'action.hover', px: 1.5, py: 1, color: 'text.primary' }}>
                    {f.value}
                  </Typography>
                </Box>
              );
            }
            const value = values[f.id] ?? '';
            return (
              <Box key={f.id} sx={{ display: 'grid', gap: 0.5 }}>
                <Typography component="label" htmlFor={`admin-action-${f.id}`} variant="fieldTitle" sx={{ fontWeight: 500, '&::after': 'required' in f && f.required ? { content: '" *"', color: 'error.main' } : undefined }}>
                  {f.label}
                </Typography>
                {f.kind === 'markdown' ? (
                  <MarkdownEditor id={`admin-action-${f.id}`} value={String(value)} onChange={(next) => setValues((v) => ({ ...v, [f.id]: next }))} placeholder={f.placeholder} maxLength={f.maxLength} rows={f.rows ?? 10} focusRef={focusRef} />
                ) : f.kind === 'tags' ? (
                  <TagsInput id={`admin-action-${f.id}`} value={Array.isArray(value) ? value : []} onChange={(next) => setValues((v) => ({ ...v, [f.id]: next }))} placeholder={f.placeholder} maxTagLength={f.maxTagLength} maxTags={f.maxTags} focusRef={focusRef} />
                ) : f.kind === 'textarea' ? (
                  <TextField
                    id={`admin-action-${f.id}`}
                    inputRef={focusRef}
                    fullWidth
                    multiline
                    rows={f.rows ?? 3}
                    value={value}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                    placeholder={f.placeholder}
                    slotProps={{ htmlInput: { maxLength: f.maxLength } }}
                    sx={{ '& .MuiInputBase-inputMultiline': { resize: 'vertical' } }}
                  />
                ) : (
                  <AppTextField
                    ref={focusRef}
                    id={`admin-action-${f.id}`}
                    type="text"
                    value={value}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                    placeholder={f.placeholder}
                    maxLength={f.maxLength}
                  />
                )}
              </Box>
            );
          })}
        </Box>
    </AppDialog>
  );
}
