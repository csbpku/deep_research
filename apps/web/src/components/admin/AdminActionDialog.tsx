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
import { Eye, FileText, Pencil, X } from 'lucide-react';

import MarkdownContent from '@/components/MarkdownContent';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

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
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  rows: number;
}) {
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-end border-b border-border bg-muted/30 p-1">
        <div className="inline-flex rounded border border-border bg-card p-0.5" role="group" aria-label="正文视图">
          <Button type="button" size="xs" variant={mode === 'write' ? 'secondary' : 'ghost'} onClick={() => setMode('write')}>
            <Pencil /> 编辑
          </Button>
          <Button type="button" size="xs" variant={mode === 'preview' ? 'secondary' : 'ghost'} onClick={() => setMode('preview')}>
            <Eye /> 预览
          </Button>
        </div>
      </div>
      {mode === 'write' ? (
        <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={maxLength} rows={rows} className="resize-y rounded-none border-0 shadow-none focus-visible:ring-0" />
      ) : (
        <div className="min-h-[220px] overflow-auto px-3 py-2"><MarkdownContent content={value || '_（暂无内容）_'} compact /></div>
      )}
    </div>
  );
}

function TagsInput({
  id,
  value,
  onChange,
  placeholder,
  maxTagLength = 40,
  maxTags = 10,
}: {
  id: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  maxTagLength?: number;
  maxTags?: number;
}) {
  const [pending, setPending] = useState('');
  const commit = () => {
    const tag = pending.trim().replace(/,+$/u, '').slice(0, maxTagLength);
    if (!tag || value.includes(tag) || value.length >= maxTags) { setPending(''); return; }
    onChange([...value, tag]); setPending('');
  };
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1.5">
        {value.map((tag) => <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs">{tag}<button type="button" onClick={() => onChange(value.filter((v) => v !== tag))} aria-label={`移除标签 ${tag}`}><X className="size-3" /></button></span>)}
      </div>
      <Input id={id} value={pending} placeholder={placeholder ?? '输入标签后按 Enter'} onChange={(e) => { const next = e.target.value; if (next.endsWith(',')) { setPending(next.slice(0, -1)); requestAnimationFrame(commit); } else setPending(next); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } }} disabled={value.length >= maxTags} />
      <input type="hidden" value={value.join(',')} readOnly />
      <p className="text-xs text-muted-foreground">最多 {maxTags} 个，每个不超过 {maxTagLength} 字</p>
    </div>
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="grid gap-3">
          {fields.map((f) => {
            if (f.kind === 'static') {
              return (
                <div key={f.id} className="grid gap-1">
                  <p className="text-xs font-medium text-muted-foreground">{f.label}</p>
                  <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm leading-relaxed text-foreground">
                    {f.value}
                  </p>
                </div>
              );
            }
            const value = values[f.id] ?? '';
            return (
              <div key={f.id} className="grid gap-1">
                <label htmlFor={`admin-action-${f.id}`} className={cn('text-sm font-medium', 'required' in f && f.required && "after:ml-0.5 after:text-destructive after:content-['*']")}>
                  {f.label}
                </label>
                {f.kind === 'markdown' ? (
                  <MarkdownEditor id={`admin-action-${f.id}`} value={String(value)} onChange={(next) => setValues((v) => ({ ...v, [f.id]: next }))} placeholder={f.placeholder} maxLength={f.maxLength} rows={f.rows ?? 10} />
                ) : f.kind === 'tags' ? (
                  <TagsInput id={`admin-action-${f.id}`} value={Array.isArray(value) ? value : []} onChange={(next) => setValues((v) => ({ ...v, [f.id]: next }))} placeholder={f.placeholder} maxTagLength={f.maxTagLength} maxTags={f.maxTags} />
                ) : f.kind === 'textarea' ? (
                  <Textarea
                    id={`admin-action-${f.id}`}
                    value={value}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                    placeholder={f.placeholder}
                    maxLength={f.maxLength}
                    rows={f.rows ?? 3}
                  />
                ) : (
                  <Input
                    id={`admin-action-${f.id}`}
                    type="text"
                    value={value}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                    placeholder={f.placeholder}
                    maxLength={f.maxLength}
                  />
                )}
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            disabled={!valid || pending}
            onClick={() => void onSubmit(values)}
          >
            {pending ? '提交中…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
