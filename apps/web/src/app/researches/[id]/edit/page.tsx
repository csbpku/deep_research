'use client';

// 调研库编辑器页面 —— 新建 + 编辑。
//
// 路由：
//   /researches/new  → 空白编辑器（创建新草稿）
//   /researches/[id]/edit → 编辑已有草稿或已发布内容
//
// 功能：
//   - Markdown 正文（textarea）
//   - 结构化字段：标题、背景、结论、风险
//   - 标签
//   - 保存草稿 / 发布
//   - creationMethod 徽标

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bold,
  Braces,
  Columns2,
  Eye,
  Heading2,
  Italic,
  Keyboard,
  List,
  Maximize2,
  Minimize2,
  PenLine,
  Save,
  Send,
} from 'lucide-react';

import MarkdownContent from '@/components/MarkdownContent';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { TagChip, TagList } from '@/components/domain/TagChip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUnsavedGuard } from '@/lib/editor/use-unsaved-guard';
import { useAutoSave } from '@/lib/editor/use-auto-save';

interface ResearchDetail {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  background: string | null;
  conclusion: string | null;
  risks: string | null;
  tags: string[];
  authorId: string;
  creationMethod: string;
  aiAssisted: boolean;
  publishedAt: string | null;
  createdAt: string;
  author: { id: string; name: string };
  audits?: AuditEntry[];
  commentCount?: number;
}

interface AuditEntry {
  id: string;
  action: string;
  diff: unknown;
  createdAt: string;
  editor: { id: string; name: string };
}

export default function EditorPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const isNew = !params?.id || params.id === 'new';

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [view, setView] = useState<'write' | 'split' | 'preview'>('write');
  const [fullscreen, setFullscreen] = useState(false);
  const [background, setBackground] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [risks, setRisks] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    draftSnapshot({ title: '', body: '', background: '', conclusion: '', risks: '', tagsInput: '' }),
  );
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // 加载已有数据
  const { data: existing, isLoading: loadingExisting } = useQuery<ResearchDetail>({
    queryKey: ['research', params?.id],
    queryFn: async () => {
      const res = await fetch(`/api/researches/${params!.id}`);
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    enabled: !isNew && !!params?.id,
  });

  useEffect(() => {
    if (existing) {
      setTitle(existing.title);
      setBody(existing.body);
      setBackground(existing.background ?? '');
      setConclusion(existing.conclusion ?? '');
      setRisks(existing.risks ?? '');
      setTagsInput(existing.tags.join(', '));
      setSavedSnapshot(
        draftSnapshot({
          title: existing.title,
          body: existing.body,
          background: existing.background ?? '',
          conclusion: existing.conclusion ?? '',
          risks: existing.risks ?? '',
          tagsInput: existing.tags.join(', '),
        }),
      );
    }
  }, [existing]);

  const tags = tagsInput
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const currentSnapshot = useMemo(
    () => draftSnapshot({ title, body, background, conclusion, risks, tagsInput }),
    [title, body, background, conclusion, risks, tagsInput],
  );
  const isDirty = currentSnapshot !== savedSnapshot;
  // 编辑器离开保护：dirty 时拦截同窗口导航与浏览器关闭，并弹确认。
  const { guardedRouter, allowNext, confirmDialog } = useUnsavedGuard(isDirty, '尚未保存的修改会在离开后丢失。');

  const wordCount = body.replace(/\s/gu, '').length;

  // 解析 H1~H3 标题作为大纲；空文档返回空数组。
  const outline = useMemo(() => {
    const re = /^(#{1,3})\s+(.+)$/gm;
    const out: { id: string; level: 1 | 2 | 3; text: string }[] = [];
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(body)) !== null) {
      out.push({ id: `h-${i++}-${m[2].slice(0, 16).replace(/\s+/g, '-')}`, level: m[1].length as 1 | 2 | 3, text: m[2].trim() });
    }
    return out;
  }, [body]);

  // 保存草稿
  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = { title, body, background: background || null, conclusion: conclusion || null, risks: risks || null, tags };
      let res: Response;
      if (isNew) {
        res = await fetch('/api/researches', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            title: title || '未命名调研库',
            body: body || '# 开始编写...',
          }),
        });
      } else {
        res = await fetch(`/api/researches/${params!.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? '保存失败');
      }
      return res.json();
    },
    onSuccess: (data) => {
      setSavedSnapshot(currentSnapshot);
      setLastSavedAt(new Date());
      queryClient.invalidateQueries({ queryKey: ['researches'] });
      if (isNew) {
        // 保存成功 + isDirty 即将变 false，但 React 重渲染之前
        // history 仍处于拦截态。allowNext 给本次 replace 开一道门。
        allowNext();
        router.replace(`/researches/${data.id}/edit`);
      }
    },
    onError: (e: Error) => {
      setError(e.message);
    },
  });

  const handleSave = useCallback(async () => {
    setError('');
    setSaving(true);
    try {
      await saveMutation.mutateAsync();
    } finally {
      setSaving(false);
    }
  }, [saveMutation]);

  // 自动保存（draft 状态启用，发布后停止）；失败容错由 useAutoSave 内部 state 标识。
  const autoSave = useAutoSave(JSON.stringify({ title, body, background, conclusion, risks, tagsInput }), {
    delayMs: 1500,
    onSave: async (snapshot) => {
      if (!isDirty) return;
      const parsed = JSON.parse(snapshot) as typeof currentSnapshot & { tagsInput: string };
      if (JSON.stringify(parsed) === savedSnapshot) return;
      await saveMutation.mutateAsync();
    },
  });
  const showAutoStatus = Boolean(existing && existing.status === 'draft' && autoSave.status !== 'idle');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSave]);

  const applyMarkdown = useCallback(
    (before: string, after = before, placeholder = '文本', linePrefix = false) => {
      const textarea = bodyRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = body.slice(start, end) || placeholder;
      const insertion = linePrefix
        ? selected
            .split('\n')
            .map((line) => `${before}${line}`)
            .join('\n')
        : `${before}${selected}${after}`;
      const next = `${body.slice(0, start)}${insertion}${body.slice(end)}`;
      setBody(next);
      requestAnimationFrame(() => {
        textarea.focus();
        const selectionStart = start + before.length;
        textarea.setSelectionRange(selectionStart, selectionStart + selected.length);
      });
    },
    [body],
  );

  const hasAiDraftChanges = Boolean(existing?.creationMethod === 'ai_research' && (
    title !== existing.title
    || body !== existing.body
    || background !== (existing.background ?? '')
    || conclusion !== (existing.conclusion ?? '')
    || risks !== (existing.risks ?? '')
    || tagsInput !== existing.tags.join(', ')
  ));

  // 发布
  const publishMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/researches/${existing?.id}/publish`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? '发布失败');
      }
      return res.json();
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['researches'] }),
        queryClient.invalidateQueries({ queryKey: ['research', existing?.id] }),
      ]);
      allowNext();
      router.push(`/researches/${existing?.id}`);
      router.refresh();
    },
    onError: (e: Error) => {
      setError(e.message);
    },
  });

  const handlePublish = useCallback(async () => {
    if (!existing) return;
    setError('');
    if (existing.creationMethod === 'ai_research' && hasAiDraftChanges) {
      await saveMutation.mutateAsync();
    }
    await publishMutation.mutateAsync();
  }, [existing, hasAiDraftChanges, publishMutation, saveMutation]);

  const publishDisabled =
    publishMutation.isPending ||
    (existing?.creationMethod === 'ai_research' && !hasAiDraftChanges);

  const editorTools = [
    { label: '加粗', icon: Bold, action: () => applyMarkdown('**', '**', '重点') },
    { label: '斜体', icon: Italic, action: () => applyMarkdown('*', '*', '强调') },
    { label: '二级标题', icon: Heading2, action: () => applyMarkdown('## ', '', '小节标题', true) },
    { label: '列表', icon: List, action: () => applyMarkdown('- ', '', '列表项', true) },
    { label: '行内代码', icon: Braces, action: () => applyMarkdown('`', '`', 'code') },
  ] as const;

  return (
    <div className="mx-auto max-w-shell">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button type="button" variant="ghost" size="icon-sm" onClick={guardedRouter.back} aria-label="返回">
            <ArrowLeft />
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-tight">
                {isNew ? '新建调研' : '编辑草稿'}
              </h1>
              {existing?.creationMethod && (
                <StatusBadge kind="method" value={existing.creationMethod} />
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isDirty ? '有未保存修改' : lastSavedAt ? '刚刚保存' : '已加载最新版本'}
              <span className="mx-1.5">·</span>
              {wordCount.toLocaleString('zh-CN')} 字
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleSave} disabled={saving || !isDirty}>
            <Save />
            {saving ? '保存中…' : '保存草稿'}
          </Button>
          {existing && existing.status === 'draft' && (
            <Button type="button" size="sm" onClick={() => setPublishConfirmOpen(true)} disabled={publishDisabled}>
              <Send />
              {existing.creationMethod === 'ai_research' && !hasAiDraftChanges
                ? '修改后发布'
                : publishMutation.isPending
                  ? '发布中…'
                  : '发布调研'}
            </Button>
          )}
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <section className="min-w-0 overflow-hidden rounded-md border border-border bg-card shadow-sm">
          <div className="border-b border-border px-5 py-3">
            <label htmlFor="edit-title" className="sr-only">标题</label>
            <Input
              id="edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="给这份调研起一个明确的标题…"
              className="h-auto border-0 bg-transparent px-0 py-1 text-xl font-semibold shadow-none focus-visible:ring-0"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-3 py-2">
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setFullscreen((f) => !f)} title={fullscreen ? '退出全屏' : '全屏编辑'} aria-label={fullscreen ? '退出全屏' : '全屏编辑'}>{fullscreen ? <Minimize2 /> : <Maximize2 />}</Button>
            {editorTools.map((tool) => {
              const Icon = tool.icon;
              return (
                <Button key={tool.label} type="button" variant="ghost" size="icon-sm" onClick={tool.action} title={tool.label} aria-label={tool.label} disabled={view === 'preview'}>
                  <Icon />
                </Button>
              );
            })}
            <span className="mx-1 h-5 w-px bg-border" />
            <span className="hidden text-[11px] text-muted-foreground sm:inline">Markdown</span>
            <details className="relative ml-1">
              <summary className="inline-flex size-7 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="快捷键说明"><Keyboard className="size-3.5" /></summary>
              <div className="absolute right-0 top-9 z-20 w-56 rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md">
                <p className="mb-1 font-medium text-foreground">键盘快捷键</p>
                <ul className="space-y-1 text-muted-foreground">
                  <li><kbd className="font-mono">⌘/Ctrl + S</kbd> 保存草稿</li>
                  <li><kbd className="font-mono">⌘/Ctrl + B</kbd> 加粗（选中文字）</li>
                  <li><kbd className="font-mono">⌘/Ctrl + I</kbd> 斜体</li>
                  <li>工具栏：加粗 / 斜体 / 标题 / 列表 / 行内代码</li>
                </ul>
              </div>
            </details>
            <div className="ml-auto inline-flex rounded-md border border-border bg-card p-0.5" role="group" aria-label="编辑器视图">
              {([
                { key: 'write', label: '编辑', icon: PenLine },
                { key: 'split', label: '分栏', icon: Columns2 },
                { key: 'preview', label: '预览', icon: Eye },
              ] as const).map((item) => {
                const Icon = item.icon;
                return (
                  <Button key={item.key} type="button" variant={view === item.key ? 'secondary' : 'ghost'} size="xs" aria-pressed={view === item.key} onClick={() => setView(item.key)} className="gap-1.5">
                    <Icon />
                    <span className="hidden sm:inline">{item.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>

          <div className={view === 'split' ? 'grid xl:grid-cols-2' : ''}>
            {view !== 'preview' && (
              <div>
                <label htmlFor="edit-body" className="sr-only">正文 Markdown</label>
                <Textarea
                  ref={bodyRef}
                  id="edit-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={'# 从问题背景开始\n\n写下事实、判断和仍需验证的风险…'}
                  spellCheck={false}
                  className="min-h-[560px] resize-y rounded-none border-0 bg-transparent px-5 py-5 font-sans text-[14px] leading-[1.6] shadow-none focus-visible:ring-0"
                />
              </div>
            )}
            {view !== 'write' && (
              <div className={view === 'split' ? 'min-h-[560px] border-t border-border px-6 py-5 xl:border-l xl:border-t-0' : 'min-h-[560px] px-7 py-6'}>
                <MarkdownContent content={body || '# 开始编写...'} compact />
              </div>
            )}
          </div>

          <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
            <span>{isDirty ? '未保存' : '已保存'}</span>
            <span aria-hidden>·</span>
            <span>{wordCount.toLocaleString('zh-CN')} 字</span>
            <span aria-hidden>·</span>
            <span>⌘/Ctrl + S 保存</span>
            {showAutoStatus ? <span className="ml-auto">{autoSaveLabel(autoSave.status)}</span> : null}
            {existing?.aiAssisted ? <span className="ml-auto">AI 协助产物，请在发布前核对来源</span> : null}
          </footer>
        </section>

        <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <details open className="rounded-md border border-border bg-card p-3">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
            研究摘要
          </summary>
          <div className="mt-3 space-y-2.5">
            {(
              [
                { id: 'bg', label: '背景', value: background, set: setBackground, ph: '调研背景…' },
                { id: 'cc', label: '结论', value: conclusion, set: setConclusion, ph: '调研结论…' },
                { id: 'rk', label: '风险', value: risks, set: setRisks, ph: '风险与待验证项…' },
              ] as const
            ).map((f) => (
              <div key={f.id} className="grid gap-1">
                <label htmlFor={`edit-${f.id}`} className="text-xs text-muted-foreground">
                  {f.label}
                </label>
                <Textarea
                  id={`edit-${f.id}`}
                  value={f.value}
                  onChange={(e) => f.set(e.target.value)}
                  rows={3}
                  placeholder={f.ph}
                  className="resize-y text-[13px]"
                />
              </div>
            ))}
          </div>
          </details>

          <div className="rounded-md border border-border bg-card p-3">
          <label htmlFor="edit-tags" className="text-sm font-medium">
            标签
          </label>
          <Input
            id="edit-tags"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="例如: React, TypeScript, 架构"
          />
          {tags.length > 0 && (
            <TagList className="mt-1">
              {tags.map((t) => (
                <TagChip key={t}>{t}</TagChip>
              ))}
            </TagList>
          )}
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            用逗号分隔。建议保留 2–5 个能帮助团队检索的技术词。
          </p>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">发布检查</p>
            <ul className="mt-2 space-y-1.5">
              <li>标题能说明研究问题</li>
              <li>结论与证据可以相互对应</li>
              <li>风险和待验证项已明确</li>
            </ul>
          </div>
        </aside>
      </div>
      <Dialog open={publishConfirmOpen} onOpenChange={setPublishConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认发布调研？</DialogTitle>
            <DialogDescription>
              发布后团队成员可以阅读和评论。请确认结论、证据和风险已核对。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPublishConfirmOpen(false)}>
              继续编辑
            </Button>
            <Button
              type="button"
              disabled={publishMutation.isPending}
              onClick={async () => {
                await handlePublish();
                setPublishConfirmOpen(false);
              }}
            >
              <Send />{publishMutation.isPending ? '发布中…' : '确认发布'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </div>
  );
}

function draftSnapshot(fields: {
  title: string;
  body: string;
  background: string;
  conclusion: string;
  risks: string;
  tagsInput: string;
}): string {
  return JSON.stringify(fields);
}

function autoSaveLabel(status: 'idle' | 'pending' | 'saving' | 'saved' | 'error') {
  switch (status) {
    case 'pending': return '编辑中…';
    case 'saving': return '自动保存中…';
    case 'saved': return '已自动保存';
    case 'error': return '自动保存失败（点保存草稿重试）';
    default: return '';
  }
}
