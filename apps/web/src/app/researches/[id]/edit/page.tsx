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
  Check,
  Columns2,
  ExternalLink,
  FileText,
  Eye,
  Heading2,
  Italic,
  Keyboard,
  List,
  ListChecks,
  Link2,
  Maximize2,
  Minimize2,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Quote,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Table2,
  X,
} from 'lucide-react';

import MarkdownContent from '@/components/MarkdownContent';
import { type CommentAnchor } from '@/components/CommentSection';
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
import { resolveResearchSourceLink } from '@/lib/research-source-link';
import { sha256Hex } from '@/lib/text-anchor';
import { commandQuery, matchingCommands, type MarkdownCommand } from '@/lib/editor/markdown-commands';
import { activeOutlineItem, parseOutline } from '@/lib/editor/outline';
import { cleanResearchMarkdown } from '@/lib/research-markdown-cleanup';

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
  reviewStatus: string | null;
  reviewAttempts: number;
  reviewSummary: {
    corrected_count?: number;
    unverified_count?: number;
    contradicted_count?: number;
  } | null;
  reviewedAt: string | null;
  author: { id: string; name: string };
  audits?: AuditEntry[];
  commentCount?: number;
  researchSources?: ResearchSourceItem[];
}

interface ResearchSourceItem {
  id: string;
  sourceRef: { type?: string; value?: string } | unknown;
  canonicalKey: string;
  title: string | null;
  description: string | null;
}

interface CitationItem {
  id: string;
  marker: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  contentHash: string;
  source: ResearchSourceItem;
}

interface AuditEntry {
  id: string;
  action: string;
  diff: unknown;
  prevSnapshot?: {
    title?: string;
    body?: string;
    background?: string | null;
    conclusion?: string | null;
    risks?: string | null;
    tags?: string[];
  } | null;
  createdAt: string;
  editor: { id: string; name: string };
}

interface DraftFields {
  title: string;
  body: string;
  background: string;
  conclusion: string;
  risks: string;
  tagsInput: string;
}

const OUTLINE_WIDTH_KEY = 'research-editor-outline-width';
const TOOLS_WIDTH_KEY = 'research-editor-tools-width';
const OUTLINE_COLLAPSED_KEY = 'research-editor-outline-collapsed';
const TOOLS_COLLAPSED_KEY = 'research-editor-tools-collapsed';

function clampOutlineWidth(value: number): number {
  return Math.min(320, Math.max(150, value));
}

function clampToolsWidth(value: number): number {
  return Math.min(460, Math.max(240, value));
}

function storedNumber(key: string, fallback: number, clamp: (value: number) => number): number {
  if (typeof window === 'undefined') return fallback;
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) ? clamp(value) : fallback;
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
  const [manualSaveRequired, setManualSaveRequired] = useState(false);
  const [outlineTarget, setOutlineTarget] = useState<string | null>(null);
  const [sidePanel, setSidePanel] = useState<'sources' | 'assistant' | 'versions' | 'details'>('sources');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const [outlineWidth, setOutlineWidth] = useState(210);
  const [toolsCollapsed, setToolsCollapsed] = useState(false);
  const [toolsWidth, setToolsWidth] = useState(320);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [selectedAnchor, setSelectedAnchor] = useState<CommentAnchor | null>(null);
  const [commandState, setCommandState] = useState<{ query: string; start: number } | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [selectionMessage, setSelectionMessage] = useState('');
  const [bodyHash, setBodyHash] = useState('');
  const [assistantResult, setAssistantResult] = useState<{ operation: string; original: string; suggestion: string | null; rationale: string; claims: Array<{ text: string; verdict: string; evidence?: string }>; warnings: string[] } | null>(null);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<'outline' | 'tools' | null>(null);
  const skipExistingSyncRef = useRef(false);

  useEffect(() => {
    setOutlineWidth(storedNumber(OUTLINE_WIDTH_KEY, 210, clampOutlineWidth));
    setToolsWidth(storedNumber(TOOLS_WIDTH_KEY, 320, clampToolsWidth));
    setOutlineCollapsed(window.localStorage.getItem(OUTLINE_COLLAPSED_KEY) === 'true');
    setToolsCollapsed(window.localStorage.getItem(TOOLS_COLLAPSED_KEY) === 'true');
  }, []);

  useEffect(() => { window.localStorage.setItem(OUTLINE_WIDTH_KEY, String(outlineWidth)); }, [outlineWidth]);
  useEffect(() => { window.localStorage.setItem(TOOLS_WIDTH_KEY, String(toolsWidth)); }, [toolsWidth]);
  useEffect(() => { window.localStorage.setItem(OUTLINE_COLLAPSED_KEY, String(outlineCollapsed)); }, [outlineCollapsed]);
  useEffect(() => { window.localStorage.setItem(TOOLS_COLLAPSED_KEY, String(toolsCollapsed)); }, [toolsCollapsed]);

  const startResize = useCallback((kind: 'outline' | 'tools', event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    resizeRef.current = kind;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const kind = resizeRef.current;
      const rect = workbenchRef.current?.getBoundingClientRect();
      if (!kind || !rect) return;
      if (kind === 'outline') {
        setOutlineWidth(clampOutlineWidth(event.clientX - rect.left));
      } else {
        setToolsWidth(clampToolsWidth(rect.right - event.clientX));
      }
    };
    const onPointerUp = () => {
      resizeRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  const adjustResize = useCallback((kind: 'outline' | 'tools', delta: number) => {
    if (kind === 'outline') setOutlineWidth((value) => clampOutlineWidth(value + delta));
    else setToolsWidth((value) => clampToolsWidth(value + delta));
  }, []);

  // 加载已有数据
  const { data: existing, isLoading: loadingExisting, isError: existingError } = useQuery<ResearchDetail>({
    queryKey: ['research', params?.id],
    queryFn: async () => {
      const res = await fetch(`/api/researches/${params!.id}`);
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    },
    enabled: !isNew && !!params?.id,
  });

  const citationsQuery = useQuery<{ items: CitationItem[] }>({
    queryKey: ['research-citations', params?.id],
    queryFn: async () => (await fetch(`/api/researches/${params!.id}/citations`, { cache: 'no-store' })).json(),
    enabled: Boolean(existing && !isNew),
  });

  useEffect(() => { void sha256Hex(body).then(setBodyHash); }, [body]);
  useEffect(() => {
    if (existing) {
      if (skipExistingSyncRef.current) {
        skipExistingSyncRef.current = false;
        return;
      }
      setTitle(existing.title);
      setBody(cleanResearchMarkdown(existing.body));
      setBackground(existing.background ?? '');
      setConclusion(existing.conclusion ?? '');
      setRisks(existing.risks ?? '');
      setTagsInput(existing.tags.join(', '));
      setSavedSnapshot(
        draftSnapshot({
          title: existing.title,
          body: cleanResearchMarkdown(existing.body),
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
  const outline = useMemo(() => parseOutline(body), [body]);

  const jumpToOutline = useCallback((item: { id: string; offset: number }) => {
    const textarea = bodyRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(item.offset, item.offset);
    setOutlineTarget(item.id);
  }, []);

  const updateOutlineTarget = useCallback((offset: number) => {
    const current = activeOutlineItem(outline, offset);
    setOutlineTarget(current?.id ?? null);
  }, [outline]);

  const handleTextSelection = useCallback(() => {
    const textarea = bodyRef.current;
    if (!textarea || textarea.selectionStart === textarea.selectionEnd) {
      setSelectedText(''); setSelectedAnchor(null);
      return;
    }
    const quote = body.slice(textarea.selectionStart, textarea.selectionEnd).trim();
    setSelectedText(quote);
    updateOutlineTarget(textarea.selectionStart);
    void sha256Hex(body).then((contentHash) => setSelectedAnchor({ quote, startOffset: textarea.selectionStart, endOffset: textarea.selectionEnd, contentHash }));
    setSelectionMessage('');
  }, [body, updateOutlineTarget]);

  const handleBodyChange = useCallback((value: string, caret: number) => {
    setBody(value);
    updateOutlineTarget(caret);
    const query = commandQuery(value, caret);
    if (query !== null) { setCommandState({ query, start: value.lastIndexOf('\n', caret - 1) + 1 }); setCommandIndex(0); }
    else setCommandState(null);
  }, [updateOutlineTarget]);

  const insertCommand = useCallback((command: MarkdownCommand) => {
    const textarea = bodyRef.current; if (!textarea || !commandState) return;
    const caret = textarea.selectionStart;
    const lineStart = commandState.start;
    const next = `${body.slice(0, lineStart)}${command.insert}${body.slice(caret)}`;
    setBody(next); setCommandState(null);
    requestAnimationFrame(() => { textarea.focus(); const pos = lineStart + command.insert.length; textarea.setSelectionRange(pos, pos); });
  }, [body, commandState]);

  const copySelectedQuote = useCallback(async () => {
    if (!selectedText) return;
    await navigator.clipboard.writeText(`> ${selectedText.replace(/\n/g, '\n> ')}`);
    setSelectionMessage('已复制为引用格式');
  }, [selectedText]);

  const citeSelection = useCallback(async (source: ResearchSourceItem) => {
    const textarea = bodyRef.current;
    if (!textarea || !selectedAnchor || !params?.id) return;
    const marker = `[^source-${(citationsQuery.data?.items.length ?? 0) + 1}]`;
    const res = await fetch(`/api/researches/${params.id}/citations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: source.id, marker, ...selectedAnchor }) });
    if (!res.ok) { setSelectionMessage('引用保存失败'); return; }
    const caret = textarea.selectionEnd;
    setBody(`${body.slice(0, caret)} ${marker}${body.slice(caret)}`);
    setSelectionMessage(`已插入引用 ${marker}`);
    await queryClient.invalidateQueries({ queryKey: ['research-citations', params.id] });
  }, [body, citationsQuery.data?.items.length, params?.id, queryClient, selectedAnchor]);

  const jumpToCitation = useCallback((citation: CitationItem) => {
    const textarea = bodyRef.current;
    if (!textarea) return;
    const offset = body.indexOf(citation.marker);
    if (offset < 0) { setSelectionMessage('正文中暂未找到该引用标记'); return; }
    textarea.focus(); textarea.setSelectionRange(offset, offset + citation.marker.length);
  }, [body]);

  const runAssistant = useCallback(async (operation: string) => {
    if (!params?.id || !['rewrite', 'summarize', 'counterpoint', 'fact_check', 'conclusion_check'].includes(operation)) return;
    setAssistantBusy(true); setError('');
    try {
      const res = await fetch(`/api/researches/${params.id}/assistant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        operation,
        selection: selectedAnchor ? {
          quote: selectedAnchor.quote,
          startOffset: selectedAnchor.startOffset,
          endOffset: selectedAnchor.endOffset,
          contentHash: selectedAnchor.contentHash,
        } : undefined,
      }) });
      const payload = await res.json() as typeof assistantResult & { message?: string; requestId?: string };
      if (!res.ok) throw new Error(payload.message ?? 'AI 助手暂时不可用');
      setAssistantResult(payload);
    } catch (assistantError) { setError(assistantError instanceof Error ? assistantError.message : 'AI 助手暂时不可用'); }
    finally { setAssistantBusy(false); }
  }, [params?.id, selectedAnchor]);

  const acceptAssistant = useCallback(() => {
    if (!assistantResult?.suggestion || !selectedAnchor) return;
    const start = body.indexOf(assistantResult.original);
    if (start < 0) { setError('正文已变化，建议无法安全应用'); return; }
    setBody(`${body.slice(0, start)}${assistantResult.suggestion}${body.slice(start + assistantResult.original.length)}`);
    setAssistantResult(null);
  }, [assistantResult, body, selectedAnchor]);

  const insertBlock = useCallback((block: string) => {
    const textarea = bodyRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const next = `${body.slice(0, start)}${body && !body.slice(0, start).endsWith('\n') ? '\n\n' : ''}${block}\n\n${body.slice(start)}`;
    setBody(next);
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + next.slice(start).indexOf(block) + block.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  }, [body]);

  const restoreAudit = useCallback(async (audit: AuditEntry) => {
    if (!params?.id || !audit.prevSnapshot) return;
    setError('');
    try {
      const res = await fetch(`/api/researches/${params.id}/versions/${audit.id}/restore`, { method: 'POST' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? '恢复版本失败');
      }
      const payload = await res.json() as { research: { title: string; body: string; background: string | null; conclusion: string | null; risks: string | null; tags: string[] } };
      setTitle(payload.research.title);
      setBody(payload.research.body);
      setBackground(payload.research.background ?? '');
      setConclusion(payload.research.conclusion ?? '');
      setRisks(payload.research.risks ?? '');
      setTagsInput(payload.research.tags.join(', '));
      // The server has atomically restored the record and emitted a `revert`
      // audit, but the editor must still surface the result as a pending
      // change so the user explicitly confirms the restored content.
      setManualSaveRequired(true);
      setSelectionMessage('已恢复该版本');
      skipExistingSyncRef.current = true;
      await queryClient.invalidateQueries({ queryKey: ['research', params.id] });
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : '恢复版本失败');
    }
  }, [params?.id, queryClient]);

  // 保存草稿
  const saveMutation = useMutation({
    mutationFn: async ({ mode = 'manual', snapshot, signal }: { mode?: 'manual' | 'auto'; snapshot?: string; signal?: AbortSignal } = {}) => {
      const fields = snapshot ? parseDraftSnapshot(snapshot) : { title, body, background, conclusion, risks, tagsInput };
      const snapshotTags = fields.tagsInput.split(',').map((tag) => tag.trim()).filter(Boolean);
      const payload = { title: fields.title, body: fields.body, background: fields.background || null, conclusion: fields.conclusion || null, risks: fields.risks || null, tags: snapshotTags };
      let res: Response;
      if (isNew) {
        res = await fetch('/api/researches', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-save-mode': mode },
          signal,
          body: JSON.stringify({
            ...payload,
            title: fields.title || '未命名调研库',
            body: fields.body || '# 开始编写...',
          }),
        });
      } else {
        res = await fetch(`/api/researches/${params!.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-save-mode': mode },
          signal,
          body: JSON.stringify(payload),
        });
      }
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? '保存失败');
      }
      return res.json();
    },
    onSuccess: (data, variables) => {
      // Mark clean only when the response belongs to the editor's current
      // snapshot. A late auto-save must not make newer local edits appear
      // saved, even if the server accepted the older request.
      const persistedSnapshot = variables?.snapshot ?? currentSnapshot;
      if (persistedSnapshot === currentSnapshot) {
        setSavedSnapshot(persistedSnapshot);
        setLastSavedAt(new Date());
      }
      queryClient.invalidateQueries({ queryKey: ['researches'] });
      if (!isNew && params?.id && variables?.mode === 'manual') {
        // Keep the right rail (audits, review status, citations) in sync with
        // the version just persisted without replacing the user's local form.
        queryClient.invalidateQueries({ queryKey: ['research', params.id] });
      }
      if (isNew) {
        // 保存成功 + isDirty 即将变 false，但 React 重渲染之前
        // history 仍处于拦截态。allowNext 给本次 replace 开一道门。
        allowNext();
        router.replace(`/researches/${data.id}/edit`);
      }
    },
    onError: (e: Error, variables) => {
      if (variables?.signal?.aborted) return;
      setError(e.message);
    },
  });

  const handleSave = useCallback(async () => {
    setError('');
    setSaving(true);
    try {
      await saveMutation.mutateAsync({ mode: 'manual' });
      setManualSaveRequired(false);
    } finally {
      setSaving(false);
    }
  }, [saveMutation]);

  // 自动保存（draft 状态启用，发布后停止）；失败容错由 useAutoSave 内部 state 标识。
  const autoSave = useAutoSave(JSON.stringify({ title, body, background, conclusion, risks, tagsInput }), {
    delayMs: 1500,
    enabled: Boolean(existing && existing.status === 'draft' && !manualSaveRequired),
    onSave: async (snapshot, signal) => {
      if (!isDirty) return;
      if (snapshot === savedSnapshot) return;
      await saveMutation.mutateAsync({ mode: 'auto', snapshot, signal });
    },
  });
  const showAutoStatus = Boolean(existing && existing.status === 'draft' && !manualSaveRequired && autoSave.status !== 'idle');

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

  useEffect(() => {
    const onEditorKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !['b', 'i'].includes(event.key.toLowerCase())) return;
      if (document.activeElement !== bodyRef.current) return;
      event.preventDefault();
      applyMarkdown(event.key.toLowerCase() === 'b' ? '**' : '*', event.key.toLowerCase() === 'b' ? '**' : '*', event.key.toLowerCase() === 'b' ? '重点' : '强调');
    };
    window.addEventListener('keydown', onEditorKeyDown);
    return () => window.removeEventListener('keydown', onEditorKeyDown);
  }, [applyMarkdown]);

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

  const reviewMutation = useMutation({
    mutationFn: async () => {
      if (!existing?.id) throw new Error('草稿尚未创建');
      const res = await fetch(`/api/researches/${existing.id}/review`, { method: 'POST' });
      const payload = await res.json().catch(() => ({})) as { message?: string };
      if (!res.ok) throw new Error(payload.message ?? '审核失败');
      return payload;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['research', existing?.id] });
      setSidePanel('details');
    },
    onError: (e: Error) => setError(e.message),
  });

  const handleReview = useCallback(async () => {
    if (!existing) return;
    setError('');
    if (isDirty) await saveMutation.mutateAsync({ mode: 'manual' });
    await reviewMutation.mutateAsync(undefined);
  }, [existing, isDirty, reviewMutation, saveMutation]);

  const handlePublish = useCallback(async () => {
    if (!existing) return;
    setError('');
    if (isDirty) {
      await saveMutation.mutateAsync({ mode: 'manual' });
    }
    await publishMutation.mutateAsync();
  }, [existing, isDirty, publishMutation, saveMutation]);

  const summaryComplete = background.trim().length > 0 && conclusion.trim().length > 0 && risks.trim().length > 0;
  const missingSummaryFields = [
    !background.trim() ? '背景' : null,
    !conclusion.trim() ? '结论' : null,
    !risks.trim() ? '风险或待验证项' : null,
  ].filter((field): field is string => Boolean(field));
  const publishDisabled = publishMutation.isPending || !summaryComplete;
  const reviewDisabled = saving || reviewMutation.isPending;

  const editorTools = [
    { label: '加粗', icon: Bold, action: () => applyMarkdown('**', '**', '重点') },
    { label: '斜体', icon: Italic, action: () => applyMarkdown('*', '*', '强调') },
    { label: '二级标题', icon: Heading2, action: () => applyMarkdown('## ', '', '小节标题', true) },
    { label: '列表', icon: List, action: () => applyMarkdown('- ', '', '列表项', true) },
    { label: '行内代码', icon: Braces, action: () => applyMarkdown('`', '`', 'code') },
  ] as const;

  const sources = existing?.researchSources ?? [];
  const reviewItems = [
    { label: '标题说明了研究问题', done: title.trim().length >= 6 },
    { label: '正文包含可识别的结构', done: outline.length >= 2 },
    { label: '背景已经填写（必填）', done: background.trim().length > 0 },
    { label: '结论已经填写（必填）', done: conclusion.trim().length > 0 },
    { label: '风险或待验证项已经填写（必填）', done: risks.trim().length > 0 },
    { label: '至少保留一个来源', done: sources.length > 0 },
  ];

  if (!isNew && loadingExisting) {
    return <div className="mx-auto max-w-shell rounded-md border border-border bg-card p-6 text-sm text-muted-foreground" aria-busy="true">正在加载编辑器…</div>;
  }
  if (!isNew && (existingError || !existing)) {
    return <div className="mx-auto max-w-shell rounded-md border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive" role="alert">无法加载这份调研，请返回列表后重试。</div>;
  }

  return (
    <div className="mx-auto max-w-shell">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button type="button" variant="ghost" size="icon-sm" onClick={guardedRouter.back} aria-label="返回">
            <ArrowLeft />
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold tracking-normal">
                {isNew ? '新建调研' : existing?.status === 'published' ? '编辑已发布文章' : '编辑草稿'}
              </h1>
              {existing?.status && <StatusBadge kind="research" value={existing.status} />}
              {existing?.creationMethod && (
                <StatusBadge kind="method" value={existing.creationMethod} />
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {manualSaveRequired ? '已恢复，待手动保存' : isDirty ? '有未保存修改' : lastSavedAt ? '刚刚保存' : '已加载最新版本'}
              <span className="mx-1.5">·</span>
              {wordCount.toLocaleString('zh-CN')} 字
              <span className="mx-1.5">·</span>
              {Math.max(1, Math.ceil(wordCount / 450))} 分钟阅读
              {showAutoStatus ? <><span className="mx-1.5">·</span>{autoSaveLabel(autoSave.status)}</> : null}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(isNew || manualSaveRequired || existing?.status === 'published') && <Button type="button" variant="outline" size="sm" onClick={handleSave} disabled={saving || !isDirty}>
            <Save />
            {saving ? '保存中…' : isNew ? '创建草稿' : existing?.status === 'published' ? '保存修改' : '确认保存'}
          </Button>}
          {existing && existing.status === 'draft' && (
            <Button type="button" size="sm" onClick={() => setPublishConfirmOpen(true)} disabled={publishDisabled} title={!summaryComplete ? '发布前必须填写背景、结论和风险或待验证项' : '发布调研'}>
              <Send />
              {publishMutation.isPending ? '发布中…' : '发布调研'}
            </Button>
          )}
        </div>
      </header>

      {selectionMessage && !selectedText ? (
        <p className="mb-3 text-xs text-status-success-fg" role="status">{selectionMessage}</p>
      ) : null}

      {existing?.status === 'draft' && missingSummaryFields.length > 0 ? (
        <div className="mb-3 rounded-md border border-status-warning-fg/30 bg-status-warning-bg/30 px-3 py-2 text-xs leading-relaxed text-status-warning-fg" role="status">
          暂不能发布，还缺少：{missingSummaryFields.join('、')}。保存草稿不受影响，补齐后即可发布。
        </div>
      ) : null}

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      <div className="mb-3 flex items-center gap-2 xl:hidden">
        <Button type="button" variant="outline" size="sm" onClick={() => setOutlineOpen(true)}>
          <PanelLeft />文章大纲 <span className="text-muted-foreground">{outline.length}</span>
        </Button>
        <Button type="button" variant="outline" size="sm" className="lg:hidden" onClick={() => setMobilePanelOpen(true)}>
          <PanelRight />研究工具
        </Button>
      </div>

      {mobilePanelOpen ? <button type="button" aria-label="关闭研究辅助遮罩" className="fixed inset-0 z-40 bg-foreground/20 lg:hidden" onClick={() => setMobilePanelOpen(false)} /> : null}

      <div ref={workbenchRef} style={{ '--outline-width': `${outlineCollapsed ? 52 : outlineWidth}px`, '--tools-width': `${toolsCollapsed ? 52 : toolsWidth}px` } as React.CSSProperties} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px] xl:grid-cols-[var(--outline-width)_minmax(0,1fr)_var(--tools-width)]">
        <aside className={`relative ${outlineOpen ? 'fixed inset-y-0 left-0 z-50 block w-[min(86vw,280px)] overflow-y-auto bg-background p-3 shadow-xl xl:static xl:z-auto xl:w-auto xl:overflow-visible xl:bg-transparent xl:p-0 xl:shadow-none' : 'hidden xl:block'}`}>
          <div className={`sticky top-4 rounded-md border border-border bg-card ${outlineCollapsed ? 'p-1.5' : 'p-3'}`}>
            <div className="mb-2 flex items-center justify-between">
              {!outlineCollapsed ? <div className="flex items-center gap-2"><p className="text-sm font-medium">文章结构</p><span className="text-[11px] text-muted-foreground">{outline.length} 节</span></div> : <span className="sr-only">文章结构已收起</span>}
              <Button type="button" variant="ghost" size="icon-sm" className="hidden xl:inline-flex" onClick={() => setOutlineCollapsed((collapsed) => !collapsed)} aria-label={outlineCollapsed ? '展开文章结构' : '收起文章结构'} title={outlineCollapsed ? '展开文章结构' : '收起文章结构'}>{outlineCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</Button>
              {outlineOpen ? <Button type="button" variant="ghost" size="icon-sm" className="xl:hidden" onClick={() => setOutlineOpen(false)} aria-label="关闭文章大纲"><X /></Button> : null}
            </div>
            {outline.length > 0 ? (
              <nav className={`max-h-[calc(100vh-9rem)] space-y-0.5 overflow-y-auto ${outlineCollapsed ? 'grid justify-items-center' : ''}`} aria-label="文章大纲">
                {outline.map((item) => (
                  <button key={item.id} type="button" onClick={() => jumpToOutline(item)} title={outlineCollapsed ? item.text : undefined} aria-label={item.text} className={`rounded transition-colors hover:bg-muted ${outlineCollapsed ? 'size-6 p-0' : 'block w-full px-2 py-1.5 text-left text-xs'} ${item.id === outlineTarget ? 'bg-muted text-foreground' : 'text-muted-foreground'} ${!outlineCollapsed && (item.level === 2 ? 'pl-4' : item.level === 3 ? 'pl-6' : '')}`}>
                    <span className={`inline-block rounded-full align-middle ${outlineCollapsed ? 'size-2' : 'mr-2 size-1.5'} ${item.id === outlineTarget ? 'bg-foreground' : 'bg-muted-foreground/50'}`} />
                    {!outlineCollapsed ? item.text : <span className="sr-only">{item.text}</span>}
                  </button>
                ))}
              </nav>
            ) : <p className="text-xs leading-relaxed text-muted-foreground">用 Markdown 标题建立结构，导航会自动出现。</p>}
          </div>
          {!outlineCollapsed ? <button
            type="button"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整文章结构栏宽度"
            aria-valuemin={150}
            aria-valuemax={320}
            aria-valuenow={outlineWidth}
            title="拖动调整文章结构栏宽度；方向键微调"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') { event.preventDefault(); adjustResize('outline', -16); }
              if (event.key === 'ArrowRight') { event.preventDefault(); adjustResize('outline', 16); }
              if (event.key === 'Home') { event.preventDefault(); setOutlineWidth(150); }
              if (event.key === 'End') { event.preventDefault(); setOutlineWidth(320); }
            }}
            onPointerDown={(event) => startResize('outline', event)}
            className="absolute -right-2 top-0 hidden h-full w-4 cursor-col-resize xl:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          ><span className="mx-auto block h-full w-px bg-transparent transition-colors hover:bg-border" /></button> : null}
        </aside>
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
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => insertBlock('> 需要核对的事实或判断')} title="插入引用块" aria-label="插入引用块" disabled={view === 'preview'}><Quote /></Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => insertBlock('- [ ] 待办事项')} title="插入待办事项" aria-label="插入待办事项" disabled={view === 'preview'}><ListChecks /></Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => insertBlock('| 维度 | 结论 | 证据 |\n| --- | --- | --- |\n| 示例 | 待填写 | 待补充 |')} title="插入对比表" aria-label="插入对比表" disabled={view === 'preview'}><Table2 /></Button>
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
                  onChange={(e) => handleBodyChange(e.target.value, e.target.selectionStart)}
                  onKeyDown={(e) => {
                    if (!commandState) return;
                    const matches = matchingCommands(commandState.query);
                    if (e.key === 'ArrowDown') { e.preventDefault(); setCommandIndex((i) => Math.min(i + 1, Math.max(0, matches.length - 1))); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setCommandIndex((i) => Math.max(0, i - 1)); }
                    else if (e.key === 'Escape') { e.preventDefault(); setCommandState(null); }
                    else if (e.key === 'Enter' && matches[commandIndex]) { e.preventDefault(); insertCommand(matches[commandIndex]); }
                  }}
                  onSelect={handleTextSelection}
                  placeholder={'# 从问题背景开始\n\n写下事实、判断和仍需验证的风险…'}
                  spellCheck={false}
                  className="min-h-[560px] resize-y rounded-none border-0 bg-transparent px-5 py-5 font-sans text-[14px] leading-[1.6] shadow-none selection:bg-primary/20 selection:text-foreground focus-visible:ring-0"
                />
                {commandState && matchingCommands(commandState.query).length > 0 && (
                  <div className="relative z-10 mx-5 -mt-2 rounded-md border border-border bg-popover p-1 shadow-md" role="listbox" aria-label="Markdown 命令">
                    {matchingCommands(commandState.query).map((command, index) => <button key={command.key} type="button" role="option" aria-selected={index === commandIndex} onMouseDown={(e) => { e.preventDefault(); insertCommand(command); }} className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs ${index === commandIndex ? 'bg-muted' : ''}`}><span className="font-medium">/{command.key}</span><span className="text-muted-foreground">{command.hint}</span></button>)}
                  </div>
                )}
              </div>
            )}
            {view !== 'write' && (
              <div className={view === 'split' ? 'min-h-[560px] border-t border-border px-6 py-5 xl:border-l xl:border-t-0' : 'min-h-[560px] px-7 py-6'}>
                <MarkdownContent content={body || '# 开始编写...'} compact />
              </div>
            )}
          </div>

          <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
            <span>{manualSaveRequired ? '待手动保存' : isDirty ? '未保存' : '已保存'}</span>
            <span aria-hidden>·</span>
            <span>{wordCount.toLocaleString('zh-CN')} 字</span>
            <span aria-hidden>·</span>
            <span>⌘/Ctrl + S 保存</span>
            {showAutoStatus ? <span className="ml-auto">{autoSaveLabel(autoSave.status)}</span> : null}
            {existing?.aiAssisted ? <span className="ml-auto">AI 协助产物，请在发布前核对来源</span> : null}
          </footer>
        </section>

        <aside className={`relative ${mobilePanelOpen ? 'fixed inset-x-3 bottom-3 z-50 block max-h-[min(76vh,680px)] lg:sticky lg:inset-x-auto lg:bottom-auto lg:top-4 lg:max-h-none lg:self-start' : 'hidden lg:sticky lg:top-4 lg:block lg:self-start'}`}>
          <div className={`flex max-h-[calc(100vh-7rem)] min-h-[420px] flex-col overflow-hidden rounded-md border border-border bg-card shadow-lg lg:shadow-none ${toolsCollapsed ? 'min-h-0' : ''}`}>
            <div className={`border-b border-border ${toolsCollapsed ? 'p-1.5' : 'px-3 pt-2'}`}>
              <div className={`flex items-center ${toolsCollapsed ? 'justify-center' : 'justify-between px-1 pb-2'}`}>
                {!toolsCollapsed ? <p className="text-sm font-medium">研究工具</p> : <span className="sr-only">研究工具已收起</span>}
                <div className="flex items-center gap-1"><span className="text-[11px] text-muted-foreground">{!toolsCollapsed ? `${outline.length} 节` : ''}</span><Button type="button" variant="ghost" size="icon-sm" className="hidden xl:inline-flex" onClick={() => setToolsCollapsed((collapsed) => !collapsed)} aria-label={toolsCollapsed ? '展开研究工具' : '收起研究工具'} title={toolsCollapsed ? '展开研究工具' : '收起研究工具'}>{toolsCollapsed ? <PanelRightOpen /> : <PanelRightClose />}</Button>{mobilePanelOpen ? <Button type="button" variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setMobilePanelOpen(false)} aria-label="关闭研究工具"><X /></Button> : null}</div>
              </div>
              {!toolsCollapsed ? <div className="-mb-px flex min-w-0 overflow-x-auto" role="tablist" aria-label="研究辅助面板">
                {([
                  { key: 'sources', label: '来源与引用' },
                  { key: 'assistant', label: 'AI 助手' },
                  { key: 'details', label: '发布准备' },
                  { key: 'versions', label: '版本历史' },
                ] as const).map((item) => (
                  <button key={item.key} type="button" role="tab" aria-selected={sidePanel === item.key} title={item.label} onClick={() => setSidePanel(item.key as typeof sidePanel)} className={`min-w-max flex-none border-b-2 px-2 py-2 text-xs ${sidePanel === item.key ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                    {item.label}
                  </button>
                ))}
              </div> : null}
            </div>

            {!toolsCollapsed ? <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {sidePanel === 'sources' && (
                <div className="space-y-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">来源用于支撑正文中的判断；正文中的引用标记会连接到对应证据。</p>
                  {selectedText && view !== 'preview' && (
                    <div className="rounded border border-border bg-muted/20 p-2.5">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground"><Quote className="size-3.5" />选文工具</div>
                      <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">“{selectedText}”</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Button type="button" size="xs" variant="outline" onClick={copySelectedQuote}><Quote />复制引用</Button>
                        <Button type="button" size="xs" variant="ghost" onClick={() => insertBlock(`> ${selectedText.replace(/\n/g, '\n> ')}`)}><Link2 />插入正文</Button>
                      </div>
                      {sources.length > 0 && <p className="mt-1.5 text-[11px] text-muted-foreground">请在下方来源卡片中选择要关联的证据。</p>}
                      {selectionMessage && <p className="mt-1.5 text-[11px] text-status-success-fg">{selectionMessage}</p>}
                    </div>
                  )}
                  <div className="space-y-2">
                    {sources.length > 0 ? sources.map((source) => {
                      const ref = (source.sourceRef ?? {}) as { type?: string; value?: string };
                      const link = resolveResearchSourceLink(ref, source.canonicalKey);
                      const citation = citationsQuery.data?.items.find((item) => item.source.id === source.id);
                      const citationMissing = Boolean(citation && !body.includes(citation.marker));
                      const citationStale = Boolean(citation && (citation.startOffset < 0 || citation.endOffset > body.length || citation.endOffset <= citation.startOffset || body.slice(citation.startOffset, citation.endOffset).trim() !== citation.quote.trim()));
                      return <div key={source.id} className="rounded border border-border/70 bg-muted/20 p-2.5"><div className="flex items-start gap-2"><Link2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{sourceTypeLabel(ref.type)}</div><button type="button" className={`line-clamp-2 text-left text-xs font-medium ${citation ? 'hover:underline' : ''}`} onClick={() => citation && jumpToCitation(citation)}>{citation?.marker ? `${citation.marker} ` : ''}{source.title || (link ? '未命名来源' : '来源链接不可用')}</button>{source.description && <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{source.description}</p>}{!link && <p className="mt-1 text-[11px] text-status-warning-fg">原始链接无法定位，请重新挂载来源。</p>}{citationMissing || citationStale ? <p className="mt-1 text-[11px] text-status-warning-fg">{citationMissing ? '正文中找不到引用标记' : '引用位置可能已失效'}</p> : null}<div className="mt-2 flex flex-wrap items-center gap-2">{link && <a href={link.href} target={link.external ? '_blank' : undefined} rel={link.external ? 'noreferrer' : undefined} className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">打开原始来源 <ExternalLink className="size-3" /></a>}{selectedAnchor && <Button type="button" variant="ghost" size="xs" className="h-6 px-1.5 text-[11px]" onClick={() => void citeSelection(source)}><FileText className="size-3" />引用这段</Button>}</div></div></div></div>;
                    }) : <div className="rounded border border-dashed border-border p-3 text-xs leading-relaxed text-muted-foreground">暂时没有挂载来源。来源会用于正文引用和事实核验，不会单独出现在发布文章中。</div>}
                  </div>
                </div>
              )}

              {sidePanel === 'assistant' && (
                <div className="space-y-3 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">AI 助手</p>
                  <p>先选中正文，再选择你要完成的任务。AI 只提供建议或核验结果，接受后才会改动正文。</p>
                  {selectedText ? <div className="rounded-md border border-primary/30 bg-primary/10 p-2.5 text-foreground shadow-[0_0_0_2px_hsl(var(--primary)/0.08)]"><p className="text-[11px] font-medium text-primary">当前选文</p><p className="mt-1.5 whitespace-pre-wrap leading-relaxed">{selectedText}</p></div> : null}
                  <div className="grid gap-2">
                    {([['rewrite', '改写得更清晰'], ['summarize', '总结这段'], ['counterpoint', '补充反方观点'], ['fact_check', '检查事实'], ['conclusion_check', '核验结论']] as const).map(([operation, label]) => <Button key={operation} type="button" variant="outline" size="sm" disabled={!selectedText || assistantBusy} onClick={() => void runAssistant(operation)}>{assistantBusy ? '处理中…' : label}</Button>)}
                  </div>
                  {assistantResult && <div className="rounded border border-border bg-muted/20 p-2.5"><p className="font-medium text-foreground">建议预览</p><div className="mt-2 grid gap-2"><div><span className="text-[11px] text-destructive">原文</span><p className="mt-1 whitespace-pre-wrap rounded bg-destructive/5 p-2">{assistantResult.original}</p></div>{assistantResult.suggestion && <div><span className="text-[11px] text-status-success-fg">建议</span><p className="mt-1 whitespace-pre-wrap rounded bg-status-success-bg/40 p-2">{assistantResult.suggestion}</p></div>}</div>{assistantResult.claims.length > 0 && <div className="mt-2 space-y-1">{assistantResult.claims.map((claim) => <p key={claim.text}><span className="font-medium">[{claim.verdict}]</span> {claim.text}{claim.evidence ? ` · ${claim.evidence}` : ''}</p>)}</div>}<div className="mt-2 flex gap-2">{assistantResult.suggestion && <Button type="button" size="xs" onClick={acceptAssistant}>接受建议</Button>}<Button type="button" size="xs" variant="ghost" onClick={() => setAssistantResult(null)}>放弃</Button></div></div>}
                  {!selectedText && <p>未选中文本。</p>}
                </div>
              )}

              {sidePanel === 'versions' && (
                <div className="space-y-2">{(existing?.audits ?? []).map((audit) => <div key={audit.id} className="rounded border border-border p-2.5"><div className="flex items-center justify-between gap-2"><div className="text-xs font-medium">{auditActionLabel(audit.action)}</div><span className="text-[10px] text-muted-foreground">{new Date(audit.createdAt).toLocaleString('zh-CN')}</span></div><div className="mt-1 text-[11px] text-muted-foreground">{audit.editor.name}</div>{auditDiffEntries(audit.diff).length > 0 ? <div className="mt-2 space-y-1">{auditDiffEntries(audit.diff).slice(0, 3).map((entry) => <div key={entry.field} className="rounded bg-muted/40 p-1.5 text-[10px]"><div className="font-medium text-foreground">{entry.field}</div><div className="mt-0.5 grid gap-0.5 text-muted-foreground"><span className="line-clamp-2"><b className="text-destructive">前：</b>{entry.from}</span><span className="line-clamp-2"><b className="text-status-success-fg">后：</b>{entry.to}</span></div></div>)}</div> : <p className="mt-2 text-[11px] text-muted-foreground">状态记录，无字段差异。</p>}<Button type="button" size="xs" variant="outline" className="mt-2" onClick={() => restoreAudit(audit)} disabled={!audit.prevSnapshot}><RotateCcw />恢复</Button></div>)}{!existing?.audits?.length && <p className="text-xs text-muted-foreground">还没有版本记录。</p>}</div>
              )}

              {sidePanel === 'details' && (
                <div className="space-y-4">
                  <p className="text-xs leading-relaxed text-muted-foreground">发布前先补齐研究摘要，再核对事实和来源。保存草稿不受这些检查影响。</p>
                  <div className="space-y-2.5">
                    <p className="text-xs font-medium text-muted-foreground">研究摘要</p>
                    {(
                      [
                        { id: 'bg', label: '背景', value: background, set: setBackground, ph: '调研背景…' },
                        { id: 'cc', label: '结论', value: conclusion, set: setConclusion, ph: '调研结论…' },
                        { id: 'rk', label: '风险', value: risks, set: setRisks, ph: '风险与待验证项…' },
                      ] as const
                    ).map((f) => (
                      <div key={f.id} className="grid gap-1">
                        <label htmlFor={`edit-${f.id}`} className="text-xs text-muted-foreground">{f.label}</label>
                        <Textarea id={`edit-${f.id}`} value={f.value} onChange={(e) => f.set(e.target.value)} rows={3} placeholder={f.ph} className="resize-y text-[13px]" />
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border pt-3">
                    <div className="rounded border border-border bg-muted/20 p-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">事实审核</span>
                        <span className="text-muted-foreground">{reviewLabel(existing?.reviewStatus)}</span>
                      </div>
                      {existing?.reviewStatus ? <p className="mt-1 text-[11px] text-muted-foreground">第 {existing.reviewAttempts}/2 轮 · 修正 {existing.reviewSummary?.corrected_count ?? 0} · 未核验 {existing.reviewSummary?.unverified_count ?? 0} · 冲突 {existing.reviewSummary?.contradicted_count ?? 0}</p> : <p className="mt-1 text-[11px] text-muted-foreground">保存后可核验当前版本。</p>}
                      {existing?.reviewStatus === 'blocked' ? <p className="mt-1 font-medium text-status-failed-fg">存在冲突事实，修订后重新审核才能发布。</p> : null}
                    </div>
                    {existing?.status === 'draft' && <Button type="button" variant="outline" size="sm" className="mt-2 w-full" onClick={handleReview} disabled={reviewDisabled}><ShieldCheck />{reviewMutation.isPending ? '审核中…' : '重新审核当前版本'}</Button>}
                    <div className="mt-3 flex items-center justify-between"><span className="text-xs text-muted-foreground">发布前检查</span><span className="text-[11px] text-muted-foreground">完成 {reviewItems.filter((item) => item.done).length}/{reviewItems.length}</span></div>
                    {!summaryComplete && <p className="mt-2 rounded border border-status-warning-fg/30 bg-status-warning-bg/30 p-2 text-[11px] leading-relaxed text-status-warning-fg">背景、结论、风险或待验证项是发布必填项。补齐后才能发布。</p>}
                    <div className="mt-2 space-y-1.5">{reviewItems.map((item) => <div key={item.label} className="flex items-start gap-2 text-xs"><span className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full ${item.done ? 'bg-status-success-bg text-status-success-fg' : 'border border-border text-transparent'}`}><Check className="size-3" /></span><span className={item.done ? 'text-foreground' : 'text-muted-foreground'}>{item.label}</span></div>)}</div>
                  </div>
                  <div className="border-t border-border pt-3">
                    <label htmlFor="edit-tags" className="text-xs font-medium text-muted-foreground">标签</label>
                    <Input id="edit-tags" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="例如: React, TypeScript, 架构" className="mt-1.5" />
                    {tags.length > 0 && <TagList className="mt-1">{tags.map((t) => <TagChip key={t}>{t}</TagChip>)}</TagList>}
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">用逗号分隔，建议保留 2–5 个检索词。</p>
                  </div>
                </div>
              )}
            </div> : null}
          </div>
          {!toolsCollapsed ? <button
            type="button"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整研究工具栏宽度"
            aria-valuemin={240}
            aria-valuemax={460}
            aria-valuenow={toolsWidth}
            title="拖动调整研究工具栏宽度；方向键微调"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') { event.preventDefault(); adjustResize('tools', 16); }
              if (event.key === 'ArrowRight') { event.preventDefault(); adjustResize('tools', -16); }
              if (event.key === 'Home') { event.preventDefault(); setToolsWidth(240); }
              if (event.key === 'End') { event.preventDefault(); setToolsWidth(460); }
            }}
            onPointerDown={(event) => startResize('tools', event)}
            className="absolute -left-2 top-0 hidden h-full w-4 cursor-col-resize xl:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          ><span className="mx-auto block h-full w-px bg-transparent transition-colors hover:bg-border" /></button> : null}
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

function draftSnapshot(fields: DraftFields): string {
  return JSON.stringify(fields);
}

function parseDraftSnapshot(snapshot: string): DraftFields {
  const parsed = JSON.parse(snapshot) as Partial<DraftFields>;
  return {
    title: typeof parsed.title === 'string' ? parsed.title : '',
    body: typeof parsed.body === 'string' ? parsed.body : '',
    background: typeof parsed.background === 'string' ? parsed.background : '',
    conclusion: typeof parsed.conclusion === 'string' ? parsed.conclusion : '',
    risks: typeof parsed.risks === 'string' ? parsed.risks : '',
    tagsInput: typeof parsed.tagsInput === 'string' ? parsed.tagsInput : '',
  };
}

function autoSaveLabel(status: 'idle' | 'pending' | 'saving' | 'saved' | 'error') {
  switch (status) {
    case 'pending': return '编辑中…';
    case 'saving': return '自动保存中…';
    case 'saved': return '已自动保存';
    case 'error': return '自动保存失败（按 ⌘/Ctrl + S 重试）';
    default: return '';
  }
}

function auditActionLabel(action: string): string {
  return ({ edit: '编辑保存', publish: '发布', revert: '恢复版本', create: '创建草稿' } as Record<string, string>)[action] ?? action;
}

function sourceTypeLabel(type: string | undefined): string {
  switch (type) {
    case 'github': return 'GitHub';
    case 'arxiv': return 'arXiv';
    case 'confluence': return 'Confluence';
    case 'web':
    case 'url': return '网页';
    case 'file': return '文件';
    default: return type || '来源';
  }
}

function auditDiffEntries(diff: unknown): Array<{ field: string; from: string; to: string }> {
  if (!diff || typeof diff !== 'object') return [];
  return Object.entries(diff as Record<string, { from?: unknown; to?: unknown }>).map(([field, value]) => ({
    field: field === 'body' ? '正文（按前后文本）' : ({ title: '标题', background: '背景', conclusion: '结论', risks: '风险', tags: '标签' } as Record<string, string>)[field] ?? field,
    from: formatDiffValue(value?.from), to: formatDiffValue(value?.to),
  }));
}

function formatDiffValue(value: unknown): string {
  if (typeof value === 'string') return value || '（空）';
  if (Array.isArray(value)) return value.join('、') || '（空）';
  if (value == null) return '（空）';
  return JSON.stringify(value);
}

function reviewLabel(status: string | null | undefined): string {
  const labels: Record<string, string> = {
    passed: '已通过',
    needs_revision: '需要修订',
    blocked: '阻止发布',
    review_unavailable: '审核不可用',
  };
  return status ? labels[status] ?? status : '未审核';
}
