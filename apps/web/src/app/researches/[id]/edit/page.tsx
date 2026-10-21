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

import { forwardRef, useState, useEffect, useCallback, useMemo, useRef, type ButtonHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { alpha, type SxProps, type Theme } from '@mui/material/styles';
import { space } from '@deep-research/design-system';
import {
  ArrowLeft,
  Bold,
  Braces,
  Columns2,
  ExternalLink,
  FileText,
  Eye,
  GitBranch,
  Heading2,
  Italic,
  Keyboard,
  List,
  ListChecks,
  Link2,
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
  Table2,
  X,
} from 'lucide-react';

import MarkdownContent from '@/components/MarkdownContent';
import { AppDialog } from '@/components/material/AppDialog';
import { type CommentAnchor } from '@/components/CommentSection';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { SectionCard } from '@/components/domain/SectionCard';
import { TagChip, TagList } from '@/components/domain/TagChip';
import { AppButton as MaterialButton } from '@/components/material/AppButton';
import { AppTextField as Input } from '@/components/material/AppTextField';
import { useUnsavedGuard } from '@/lib/editor/use-unsaved-guard';
import { useAutoSave } from '@/lib/editor/use-auto-save';
import { resolveResearchSourceLink } from '@/lib/research-source-link';
import { sha256Hex } from '@/lib/text-anchor';
import { commandQuery, matchingCommands, type MarkdownCommand } from '@/lib/editor/markdown-commands';
import { activeOutlineItem, parseOutline } from '@/lib/editor/outline';
import { cleanResearchMarkdown } from '@/lib/research-markdown-cleanup';
import type { ReviewPublicationGate } from '@/lib/research-review-decisions';
import { externalContentLabel, hasExternalInstructionSignal } from '@/lib/external-content-safety';

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
  supersedesResearchId?: string | null;
  publishedAt: string | null;
  createdAt: string;
  reviewStatus: string | null;
  reviewAttempts: number;
  reviewSummary: {
    corrected_count?: number;
    unverified_count?: number;
    contradicted_count?: number;
  } | null;
  currentReview?: {
    revisionHash: string;
    status: string;
    outcome: string | null;
    isCurrentRevision: boolean;
    isLegacyFallback: boolean;
    runId: string | null;
    executionStatus: string | null;
    attempt: number;
    startedAt: string | null;
    completedAt: string | null;
    publicationGate?: ReviewPublicationGate | null;
  };
  reviewRuns?: Array<{
    id: string;
    isCurrentRevision?: boolean;
    executionStatus: string;
    outcome: string | null;
    attempt: number;
    createdAt: string;
  }>;
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
  sourceIntent?: string | null;
  sourceQuestion?: string | null;
  reason?: string | null;
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
  const [background, setBackground] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [risks, setRisks] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  const [restoreConfirmAudit, setRestoreConfirmAudit] = useState<AuditEntry | null>(null);
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
  /* flashMessage:与 selectedText 解耦的瞬时反馈(2s 自动消失),
     避免复制 toast 在选区仍然存在时被立刻隐藏 */
  const [flashMessage, setFlashMessage] = useState('');
  useEffect(() => {
    if (!flashMessage) return;
    const t = setTimeout(() => setFlashMessage(''), 2000);
    return () => clearTimeout(t);
  }, [flashMessage]);
  const [bodyHash, setBodyHash] = useState('');
  const [assistantResult, setAssistantResult] = useState<{ operation: string; original: string; suggestion: string | null; rationale: string; claims: Array<{ text: string; verdict: string; evidence?: string }>; warnings: string[] } | null>(null);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantError, setAssistantError] = useState('');
  const [assistantOperation, setAssistantOperation] = useState<string | null>(null);
  const assistantAbortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<'outline' | 'tools' | null>(null);
  const skipExistingSyncRef = useRef(false);
  const hydratedRecordIdRef = useRef<string | null>(null);
  const formDirtyRef = useRef(false);
  const reviewClaimHandledRef = useRef<string | null>(null);

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
  const isPublishedAi = existing?.status === 'published' && existing.creationMethod === 'ai_research';

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
        hydratedRecordIdRef.current = existing.id;
        return;
      }
      // Refetches (e.g. after a manual save or review) must not overwrite text
      // typed meanwhile: only hydrate on first load of a record or when clean.
      const firstLoad = hydratedRecordIdRef.current !== existing.id;
      if (!firstLoad && formDirtyRef.current) return;
      hydratedRecordIdRef.current = existing.id;
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

  // Claim-level review links land in the editor with the exact declaration
  // that needs a decision. Select it when the report is loaded so the user
  // edits the reviewed sentence, not an arbitrary place in a long document.
  useEffect(() => {
    if (isNew || !existing || !body || typeof window === 'undefined') return;
    const searchParams = new URLSearchParams(window.location.search);
    const claim = searchParams.get('reviewClaim')?.trim();
    if (!claim || reviewClaimHandledRef.current === claim) return;
    const directOffset = body.indexOf(claim);
    const normalizedClaim = claim.replace(/\s+/gu, ' ').trim();
    const requestedStart = Number(searchParams.get('reviewStart'));
    const requestedEnd = Number(searchParams.get('reviewEnd'));
    let start = directOffset;
    let end = directOffset >= 0 ? directOffset + claim.length : -1;
    // Prefer the exact source-run offset only when the report text has not
    // been normalized between the worker and editor. The claim text match
    // below remains the safer fallback for cleaned Markdown.
    if (start < 0 && Number.isInteger(requestedStart) && requestedStart >= 0 && requestedStart < body.length) {
      start = requestedStart;
      end = Number.isInteger(requestedEnd) && requestedEnd > start
        ? Math.min(requestedEnd, body.length)
        : Math.min(start + claim.length, body.length);
    }
    if (start < 0 && normalizedClaim) {
      let cursor = 0;
      for (const line of body.split(/\r?\n/u)) {
        const normalizedLine = line.replace(/[*_`]/gu, '').replace(/\s+/gu, ' ').trim();
        if (normalizedLine.includes(normalizedClaim) || normalizedClaim.includes(normalizedLine.slice(0, 120))) {
          start = cursor;
          end = cursor + line.length;
          break;
        }
        cursor += line.length + 1;
      }
    }
    reviewClaimHandledRef.current = claim;
    setSidePanel('assistant');
    if (start >= 0 && end > start) {
      setSelectionMessage('已定位这条需要确认的结论；修改后保存，系统会更新资料检查。');
      requestAnimationFrame(() => {
        const textarea = bodyRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(start, end);
      });
    } else {
      setSelectionMessage('没有在正文中找到完全匹配的声明，请在当前段落中人工定位后修改。');
    }
  }, [body, existing, isNew]);

  const tags = tagsInput
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const currentSnapshot = useMemo(
    () => draftSnapshot({ title, body, background, conclusion, risks, tagsInput }),
    [title, body, background, conclusion, risks, tagsInput],
  );
  const isDirty = currentSnapshot !== savedSnapshot;
  formDirtyRef.current = isDirty;
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
    // 节流:长正文每次 mouseup 即算 sha256 会卡;200ms debounce 已足够文本选区停留时间
    let cancelled = false;
    setTimeout(() => {
      if (cancelled) return;
      void sha256Hex(body).then((contentHash) => setSelectedAnchor({ quote, startOffset: textarea.selectionStart, endOffset: textarea.selectionEnd, contentHash }));
    }, 200);
    setSelectionMessage('');
    return () => { cancelled = true; };
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
    setFlashMessage('已复制为引用格式');
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
    assistantAbortRef.current?.abort();
    const controller = new AbortController();
    assistantAbortRef.current = controller;
    setAssistantBusy(true); setAssistantOperation(operation); setAssistantError(''); setError('');
    try {
      const res = await fetch(`/api/researches/${params.id}/assistant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        operation,
        selection: selectedAnchor ? {
          quote: selectedAnchor.quote,
          startOffset: selectedAnchor.startOffset,
          endOffset: selectedAnchor.endOffset,
          contentHash: selectedAnchor.contentHash,
        } : undefined,
      }), signal: controller.signal });
      const payload = await res.json().catch(() => ({})) as typeof assistantResult & { message?: string; requestId?: string };
      if (!res.ok) {
        const requestHint = payload.requestId ? `（请求 ID：${payload.requestId}）` : '';
        throw new Error(`${payload.message ?? 'AI 助手暂时不可用'}${requestHint}`);
      }
      setAssistantResult(payload);
    } catch (error) {
      if (controller.signal.aborted) {
        setAssistantError('已取消本次 AI 助手请求；没有生成结果，可以重新执行。');
      } else if (error instanceof TypeError) {
        setAssistantError('AI 助手连接失败；本次没有生成结果，可以重试。');
      } else {
        setAssistantError(error instanceof Error ? error.message : 'AI 助手暂时不可用；可以重试。');
      }
    } finally {
      if (assistantAbortRef.current === controller) assistantAbortRef.current = null;
      setAssistantBusy(false);
    }
  }, [params?.id, selectedAnchor]);

  const cancelAssistant = useCallback(() => {
    assistantAbortRef.current?.abort();
  }, []);

  useEffect(() => () => assistantAbortRef.current?.abort(), []);

  const acceptAssistant = useCallback(() => {
    if (isPublishedAi || !assistantResult?.suggestion || !selectedAnchor) return;
    const start = body.indexOf(assistantResult.original);
    if (start < 0) { setError('正文已变化，建议无法安全应用'); return; }
    setBody(`${body.slice(0, start)}${assistantResult.suggestion}${body.slice(start + assistantResult.original.length)}`);
    setAssistantResult(null);
  }, [assistantResult, body, isPublishedAi, selectedAnchor]);

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
      // Remember exactly what this request persisted. onSuccess runs later
      // and must not read the live form (the user may have kept typing).
      const saved = await res.json();
      return { ...saved, persistedSnapshot: draftSnapshot(fields) } as typeof saved & { persistedSnapshot: string };
    },
    onSuccess: (data, variables) => {
      // Mark clean only when the response belongs to the editor's current
      // snapshot. A late auto-save must not make newer local edits appear
      // saved, even if the server accepted the older request.
      const persistedSnapshot = data.persistedSnapshot ?? variables?.snapshot ?? currentSnapshot;
      // The saved baseline is always what was actually persisted; newer local
      // edits therefore stay dirty instead of being replaced by a refetch.
      setSavedSnapshot(persistedSnapshot);
      if (persistedSnapshot === currentSnapshot) setLastSavedAt(new Date());
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

  const forkMutation = useMutation({
    mutationFn: async () => {
      if (!existing?.id) throw new Error('找不到要修订的研究');
      const res = await fetch(`/api/researches/${existing.id}/fork`, { method: 'POST' });
      const payload = await res.json().catch(() => ({})) as { id?: string; message?: string };
      if (!res.ok || !payload.id) throw new Error(payload.message ?? '创建修订草稿失败');
      return payload;
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['researches'] });
      allowNext();
      router.push(`/researches/${data.id}/edit`);
    },
    onError: (e: Error) => setError(e.message),
  });

  const reviewMutation = useMutation({
    mutationFn: async () => {
      if (!existing?.id) throw new Error('草稿尚未创建');
      const res = await fetch(`/api/researches/${existing.id}/review`, { method: 'POST' });
      const payload = await res.json().catch(() => ({})) as { message?: string };
      if (!res.ok) throw new Error(payload.message ?? '资料检查失败');
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

  const handleFork = useCallback(async () => {
    setError('');
    await forkMutation.mutateAsync();
  }, [forkMutation]);

  const summaryComplete = background.trim().length > 0 && conclusion.trim().length > 0 && risks.trim().length > 0;
  const missingSummaryFields = [
    !background.trim() ? '背景' : null,
    !conclusion.trim() ? '结论' : null,
    !risks.trim() ? '风险或待验证项' : null,
  ].filter((field): field is string => Boolean(field));
  const reviewRequired = existing?.creationMethod === 'ai_research';
  // The API marks the run that covers the exact current snapshot. Historical
  // runs remain useful in the audit trail, but must never drive the publish
  // button or the current-state label after an edit.
  const latestReviewRun = existing?.reviewRuns?.find((run) => run.isCurrentRevision) ?? null;
  const publicationGate = existing?.currentReview?.publicationGate ?? null;
  const researchCoverageLabel = publicationGate?.researchSufficiencyStatus === 'sufficient'
    ? '已满足'
    : publicationGate?.researchSufficiencyStatus === 'insufficient'
      ? '不足'
      : '未评估';
  const reviewPassed = existing?.currentReview
    ? existing.currentReview.status === 'passed'
    : latestReviewRun
      ? latestReviewRun.executionStatus === 'completed' && latestReviewRun.outcome === 'clear'
      : existing?.reviewStatus === 'passed';
  const reviewPublishable = reviewPassed
    || publicationGate?.status === 'clear'
    || publicationGate?.status === 'publish_with_disclosure';
  const currentReviewIsCurrent = existing?.currentReview?.isCurrentRevision === true;
  const reviewInstruction = !currentReviewIsCurrent
    ? '当前稿还没有最新的资料检查结果。保存后可以更新检查。'
    : existing?.currentReview?.status === 'queued' || existing?.currentReview?.status === 'reviewing'
      ? '资料正在后台整理；完成后会告诉你哪些内容需要处理。'
      : publicationGate?.status === 'needs_action'
      ? `有 ${publicationGate.openCount} 条结论缺少直接依据；请补充资料或修改相关内容。`
      : publicationGate?.status === 'blocked'
        ? '来源之间存在不一致；请修改相关结论后再发布。'
      : publicationGate?.status === 'coverage_insufficient'
          ? '现有资料还不足以支撑完整报告；请补充资料后再发布。'
        : publicationGate?.status === 'research_insufficient'
          ? '现有资料还没有覆盖原问题的关键部分；请补充资料后再发布。'
        : publicationGate?.status === 'unavailable'
          ? '资料检查暂未完成；可以稍后重试。'
          : '当前内容还需要处理后才能发布。';
  const publishDisabled = publishMutation.isPending || !summaryComplete || (reviewRequired && !reviewPublishable);
  const reviewInProgress = existing?.currentReview?.status === 'queued' || existing?.currentReview?.status === 'reviewing';
  const reviewDisabled = saving || reviewMutation.isPending || reviewInProgress;

  const editorTools = [
    { label: '加粗', icon: Bold, action: () => applyMarkdown('**', '**', '重点') },
    { label: '斜体', icon: Italic, action: () => applyMarkdown('*', '*', '强调') },
    { label: '二级标题', icon: Heading2, action: () => applyMarkdown('## ', '', '小节标题', true) },
    { label: '列表', icon: List, action: () => applyMarkdown('- ', '', '列表项', true) },
    { label: '行内代码', icon: Braces, action: () => applyMarkdown('`', '`', 'code') },
  ] as const;

  const sources = existing?.researchSources ?? [];
  const publicationStatus = !summaryComplete
    ? {
        label: '需要补充内容',
        detail: `还缺少：${missingSummaryFields.join('、')}。`,
        tone: 'warning' as const,
      }
    : reviewRequired && !reviewPublishable
      ? {
          label: currentReviewIsCurrent && (existing?.currentReview?.status === 'queued' || existing?.currentReview?.status === 'reviewing')
            ? '正在整理资料'
            : '需要处理',
          detail: reviewInstruction,
          tone: 'warning' as const,
        }
      : {
          label: '可以发布',
          detail: researchCoverageLabel === '未评估'
            ? '关键内容已有资料；发布前请确认它确实回答了原问题。'
            : publicationGate?.status === 'publish_with_disclosure'
              ? `可以发布，但会保留 ${publicationGate.disclosedCount} 条不确定性提示。`
              : '内容结构完整，关键内容已有可对照资料。',
          tone: 'success' as const,
        };

  if (!isNew && loadingExisting) {
    return <Paper variant="outlined" aria-busy="true" sx={{ mx: 'auto', maxWidth: 'var(--dr-width-shell)', p: 3, color: 'text.secondary' }}>正在加载编辑器…</Paper>;
  }
  if (!isNew && (existingError || !existing)) {
    return <Alert severity="error" role="alert" sx={{ mx: 'auto', maxWidth: 'var(--dr-width-shell)' }}>无法加载这份调研，请返回列表后重试。</Alert>;
  }

  return (
    <Box sx={{ mx: 'auto', width: '100%', maxWidth: 'var(--dr-width-shell)' }}>
      <Box component="header" sx={{ mb: 2, pb: 1.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', minWidth: 0, alignItems: 'center', gap: 1.5 }}>
          <Button type="button" variant="ghost" size="icon-sm" onClick={guardedRouter.back} aria-label="返回">
            <ArrowLeft />
          </Button>
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="panelTitle" component="h1" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {isNew ? '新建调研' : isPublishedAi ? '查看已发布 AI 研究' : existing?.status === 'published' ? '编辑已发布文章' : '编辑草稿'}
              </Typography>
              {existing?.status && <StatusBadge kind="research" value={existing.status} />}
              {existing?.creationMethod && (
                <StatusBadge kind="method" value={existing.creationMethod} />
              )}
            </Box>
            <Typography variant="metadata" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
              {manualSaveRequired ? '已恢复，待手动保存' : isDirty ? '有未保存修改' : lastSavedAt ? '刚刚保存' : '已加载最新版本'}
              <Box component="span" sx={{ mx: 0.75 }}>·</Box>
              {wordCount.toLocaleString('zh-CN')} 字
              <Box component="span" sx={{ mx: 0.75 }}>·</Box>
              {Math.max(1, Math.ceil(wordCount / 450))} 分钟阅读
              {showAutoStatus ? <><Box component="span" sx={{ mx: 0.75 }}>·</Box>{autoSaveLabel(autoSave.status)}</> : null}
            </Typography>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {isPublishedAi ? (
            <Button type="button" size="sm" onClick={() => void handleFork()} disabled={forkMutation.isPending}>
              <GitBranch />
              {forkMutation.isPending ? '创建中…' : '创建修订草稿'}
            </Button>
          ) : (isNew || manualSaveRequired || existing?.status === 'published' || (existing?.status === 'draft' && isDirty)) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleSave}
              disabled={saving || !isDirty}
            >
              <Save />
              {saving ? '保存中…' : isNew ? '创建草稿' : existing?.status === 'published' ? '保存修改' : '保存修改'}
            </Button>
          )}
          {existing && existing.status === 'draft' && (
            <Button type="button" size="sm" onClick={() => setPublishConfirmOpen(true)} disabled={publishDisabled} title={!summaryComplete ? '发布前必须填写背景、结论和风险或待验证项' : '发布调研'}>
              <Send />
              {publishMutation.isPending ? '发布中…' : '发布调研'}
            </Button>
          )}
        </Box>
      </Box>

      {flashMessage ? (
        <Alert
          severity="success"
          role="status"
          aria-live="polite"
          sx={{ position: 'fixed', zIndex: 'tooltip', bottom: 2, left: '50%', transform: 'translateX(-50%)', width: 'max-content', maxWidth: 'calc(100vw - 32px)', boxShadow: 'var(--dr-elevation-1)' }}
        >
          {flashMessage}
        </Alert>
      ) : null}

      {isPublishedAi ? (
        <Alert severity="info" role="status" sx={{ mb: 1.5 }}>
          <Typography variant="control" component="p" sx={{ fontWeight: 600 }}>这是已发布版本，内容保持不变。</Typography>
          <Typography variant="body2" component="p">如需修改，请创建修订草稿。新草稿会复制当前资料和引用，并更新资料检查后才能发布。</Typography>
        </Alert>
      ) : null}

      {existing?.status === 'draft' && (missingSummaryFields.length > 0 || (reviewRequired && !reviewPublishable)) ? (
        <Alert severity="warning" role="status" sx={{ mb: 1.5 }}>
          <Typography variant="control" component="p" sx={{ fontWeight: 600 }}>暂不能发布</Typography>
          <Typography variant="body2" component="p">{missingSummaryFields.length > 0 ? `还缺少：${missingSummaryFields.join('、')}。` : reviewInstruction}</Typography>
          <Typography variant="metadata" component="p" color="text.secondary">保存草稿不受影响。</Typography>
        </Alert>
      ) : null}

      {error && (
        <Alert severity="error" role="alert" sx={{ mb: 1.5 }}>
          {error}
        </Alert>
      )}
      <Box sx={{ display: { xs: 'flex', xl: 'none' }, alignItems: 'center', gap: 1, mb: 1.5 }}>
        <Button type="button" variant="outline" size="sm" onClick={() => setOutlineOpen(true)}>
          <PanelLeft />文章大纲 <Typography component="span" variant="metadata" color="text.secondary">{outline.length}</Typography>
        </Button>
        <Button type="button" variant="outline" size="sm" sx={{ display: { lg: 'none' } }} onClick={() => setMobilePanelOpen(true)}>
          <PanelRight />研究工具
        </Button>
      </Box>

      {mobilePanelOpen ? <Box component="button" type="button" aria-label="关闭研究辅助遮罩" sx={{ display: { lg: 'none' }, position: 'fixed', inset: 0, zIndex: 40, border: 0, p: 0, bgcolor: (theme) => alpha(theme.palette.text.primary, 0.2) }} onClick={() => setMobilePanelOpen(false)} /> : null}

      <Box ref={workbenchRef} style={{ '--outline-width': `${outlineCollapsed ? 52 : outlineWidth}px`, '--tools-width': `${toolsCollapsed ? 52 : toolsWidth}px` } as React.CSSProperties} sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 280px', xl: 'var(--outline-width) minmax(0, 1fr) var(--tools-width)' } }}>
        <Box component="aside" sx={{
          position: { xs: outlineOpen ? 'fixed' : 'relative', xl: 'relative' },
          top: { xs: outlineOpen ? 0 : 'auto', xl: 'auto' },
          bottom: { xs: outlineOpen ? 0 : 'auto', xl: 'auto' },
          left: { xs: outlineOpen ? 0 : 'auto', xl: 'auto' },
          zIndex: { xs: outlineOpen ? 50 : 'auto', xl: 'auto' },
          display: { xs: outlineOpen ? 'block' : 'none', xl: 'block' },
          width: { xs: outlineOpen ? 'min(86vw, 280px)' : 'auto', xl: 'auto' },
          overflowY: { xs: outlineOpen ? 'auto' : 'visible', xl: 'visible' },
          bgcolor: { xs: outlineOpen ? 'background.paper' : 'transparent', xl: 'transparent' },
          p: { xs: outlineOpen ? 1.5 : 0, xl: 0 },
          boxShadow: { xs: outlineOpen ? 'var(--dr-elevation-1)' : 'none', xl: 'none' },
        }}>
          <Paper variant="outlined" sx={{ position: 'sticky', top: 2, p: outlineCollapsed ? 0.75 : 1.5, bgcolor: 'background.paper', borderColor: 'divider' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              {!outlineCollapsed ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><Typography variant="control" component="p" sx={{ fontWeight: 600 }}>文章结构</Typography><Typography variant="metadata" color="text.secondary">{outline.length} 节</Typography></Box> : <span className="sr-only">文章结构已收起</span>}
              <Button type="button" variant="ghost" size="icon-sm" sx={{ display: { xs: 'none', xl: 'inline-flex' } }} onClick={() => setOutlineCollapsed((collapsed) => !collapsed)} aria-label={outlineCollapsed ? '展开文章结构' : '收起文章结构'} title={outlineCollapsed ? '展开文章结构' : '收起文章结构'}>{outlineCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</Button>
              {outlineOpen ? <Button type="button" variant="ghost" size="icon-sm" sx={{ display: { xl: 'none' } }} onClick={() => setOutlineOpen(false)} aria-label="关闭文章大纲"><X /></Button> : null}
            </Box>
            {outline.length > 0 ? (
              <Box component="nav" sx={{ maxHeight: 'calc(100vh - 9rem)', display: outlineCollapsed ? 'grid' : 'flex', flexDirection: 'column', alignItems: outlineCollapsed ? 'center' : 'stretch', gap: 0.5, overflowY: 'auto' }} aria-label="文章大纲">
                {outline.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant={item.id === outlineTarget ? 'secondary' : 'ghost'}
                    size={outlineCollapsed ? 'icon-sm' : 'xs'}
                    onClick={() => jumpToOutline(item)}
                    title={outlineCollapsed ? item.text : undefined}
                    aria-label={item.text}
                    sx={{
                      display: 'flex',
                      justifyContent: outlineCollapsed ? 'center' : 'flex-start',
                      width: outlineCollapsed ? 'var(--dr-control-height)' : '100%',
                      minWidth: 0,
                      px: outlineCollapsed ? 0 : item.level === 2 ? 2 : item.level === 3 ? 3 : 1,
                      textAlign: 'left',
                      whiteSpace: 'normal',
                    }}
                  >
                    <Box component="span" aria-hidden="true" sx={{ display: 'inline-block', flex: '0 0 auto', width: outlineCollapsed ? 8 : 6, height: outlineCollapsed ? 8 : 6, mr: outlineCollapsed ? 0 : 1, borderRadius: '50%', bgcolor: item.id === outlineTarget ? 'text.primary' : 'text.disabled' }} />
                    {!outlineCollapsed ? item.text : <span className="sr-only">{item.text}</span>}
                  </Button>
                ))}
              </Box>
            ) : <Typography variant="metadata" color="text.secondary">用 Markdown 标题建立结构，导航会自动出现。</Typography>}
          </Paper>
          {!outlineCollapsed ? <Box component="button"
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
            sx={{ position: 'absolute', top: 0, right: -8, display: { xs: 'none', xl: 'block' }, width: 16, height: '100%', cursor: 'col-resize', border: 0, p: 0, bgcolor: 'transparent', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 }, '&:hover > span': { bgcolor: 'divider' } }}
          ><Box component="span" sx={{ display: 'block', width: 1, height: '100%', mx: 'auto', bgcolor: 'transparent', transition: 'background-color var(--dr-motion-fast)' }} /></Box> : null}
        </Box>
        <Paper component="section" variant="outlined" sx={{ minWidth: 0, overflow: 'hidden', borderColor: 'divider', bgcolor: 'background.paper', boxShadow: 'var(--dr-elevation-1)' }}>
          <Box sx={{ borderBottom: 1, borderColor: 'divider', px: 2.5, py: 1.5 }}>
            <label htmlFor="edit-title" className="sr-only">标题</label>
            <Input
              id="edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              readOnly={isPublishedAi}
              placeholder="给这份调研起一个明确的标题…"
              sx={{ bgcolor: 'transparent', '& .MuiOutlinedInput-notchedOutline': { border: 0 }, '& .MuiOutlinedInput-input': { px: 0, py: 0.5, fontSize: 'var(--dr-type-title-medium)', fontWeight: 600 } }}
            />
          </Box>

          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.5, px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.default' }}>
            {/* 全屏编辑按钮: 当前未挂载 Fullscreen API,留待后续接入 CSS 占满视口 + ESC 退出 */}
            {editorTools.map((tool) => {
              const Icon = tool.icon;
              return (
                  <Button key={tool.label} type="button" variant="ghost" size="icon-sm" onClick={tool.action} title={tool.label} aria-label={tool.label} disabled={view === 'preview' || isPublishedAi}>
                  <Icon />
                </Button>
              );
            })}
            <Box aria-hidden="true" sx={{ mx: 0.5, width: '1px', height: 20, bgcolor: 'divider' }} />
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => insertBlock('> 需要核对的事实或判断')} title="插入引用块" aria-label="插入引用块" disabled={view === 'preview' || isPublishedAi}><Quote /></Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => insertBlock('- [ ] 待办事项')} title="插入待办事项" aria-label="插入待办事项" disabled={view === 'preview' || isPublishedAi}><ListChecks /></Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => insertBlock('| 维度 | 结论 | 证据 |\n| --- | --- | --- |\n| 示例 | 待填写 | 待补充 |')} title="插入对比表" aria-label="插入对比表" disabled={view === 'preview' || isPublishedAi}><Table2 /></Button>
            <Box aria-hidden="true" sx={{ mx: 0.5, width: '1px', height: 20, bgcolor: 'divider' }} />
            <Typography variant="metadata" color="text.secondary" sx={{ display: { xs: 'none', sm: 'inline' } }}>Markdown</Typography>
            <Box component="details" sx={{ position: 'relative', ml: 0.5 }}>
              <Box component="summary" aria-label="快捷键说明" sx={{ display: 'inline-flex', width: 'var(--dr-control-height)', height: 'var(--dr-control-height)', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', listStyle: 'none', borderRadius: 'var(--dr-radius-small)', color: 'text.secondary', '&:hover': { bgcolor: 'action.hover', color: 'text.primary' }, '&::-webkit-details-marker': { display: 'none' } }}><Keyboard size={14} /></Box>
              <Paper variant="outlined" sx={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 'tooltip', width: 224, p: 1.5, bgcolor: 'background.paper', boxShadow: 'var(--dr-elevation-1)' }}>
                <Typography variant="control" component="p" sx={{ mb: 1, fontWeight: 600 }}>键盘快捷键</Typography>
                <Box component="ul" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, m: 0, pl: 2, color: 'text.secondary', typography: 'metadata' }}>
                  <li><Box component="kbd" sx={{ fontFamily: 'monospace' }}>⌘/Ctrl + S</Box> 保存草稿</li>
                  <li><Box component="kbd" sx={{ fontFamily: 'monospace' }}>⌘/Ctrl + B</Box> 加粗（选中文字）</li>
                  <li><Box component="kbd" sx={{ fontFamily: 'monospace' }}>⌘/Ctrl + I</Box> 斜体</li>
                  <li>工具栏：加粗 / 斜体 / 标题 / 列表 / 行内代码</li>
                </Box>
              </Paper>
            </Box>
            <Paper variant="outlined" sx={{ ml: 'auto', display: 'inline-flex', p: 0.5, borderColor: 'divider' }} role="group" aria-label="编辑器视图">
              {([
                { key: 'write', label: '编辑', icon: PenLine },
                { key: 'split', label: '分栏', icon: Columns2 },
                { key: 'preview', label: '预览', icon: Eye },
              ] as const).map((item) => {
                const Icon = item.icon;
                return (
                  <Button
                    key={item.key}
                    type="button"
                    variant={view === item.key ? 'secondary' : 'ghost'}
                    size="xs"
                    aria-pressed={view === item.key}
                    aria-controls="editor-preview-pane"
                    onClick={() => setView(item.key)}
                    sx={{ gap: 0.75 }}
                  >
                    <Icon />
                    <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>{item.label}</Box>
                  </Button>
                );
              })}
            </Paper>
          </Box>

          <Box sx={view === 'split' ? { display: 'grid', gridTemplateColumns: { xl: 'repeat(2, minmax(0, 1fr))' } } : undefined}>
            {view !== 'preview' && (
              <div>
                <label htmlFor="edit-body" className="sr-only">正文 Markdown</label>
                <Textarea
                  ref={bodyRef}
                  id="edit-body"
                  value={body}
                  onChange={(e) => handleBodyChange(e.target.value, e.target.selectionStart)}
                  readOnly={isPublishedAi}
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
                  sx={{ minHeight: 560, resize: 'vertical', border: 0, borderRadius: 0, px: 2.5, py: 2.5, bgcolor: 'transparent', '&:hover': { borderColor: 'transparent' }, '&:focus-visible': { outlineOffset: -2 } }}
                />
                {commandState && matchingCommands(commandState.query).length > 0 && (
                  <Box className="material-surface" sx={{ position: 'relative', zIndex: 10, mx: 2.5, mt: -1, p: 0.5, border: 1, borderColor: 'divider', borderRadius: 'var(--dr-radius-small)', bgcolor: 'background.paper', boxShadow: 'var(--dr-elevation-1)' }} role="listbox" aria-label="Markdown 命令">
                    {matchingCommands(commandState.query).map((command, index) => (
                      <Box
                        key={command.key}
                        component="button"
                        type="button"
                        role="option"
                        aria-selected={index === commandIndex}
                        onMouseDown={(e) => { e.preventDefault(); insertCommand(command); }}
                        sx={{
                          display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between',
                          gap: 1, px: 1, py: 0.75, border: 0, borderRadius: 'var(--dr-radius-xs)',
                          appearance: 'none', bgcolor: index === commandIndex ? 'action.selected' : 'transparent',
                          color: 'text.primary', font: 'inherit', typography: 'metadata', textAlign: 'left',
                          cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' },
                        }}
                      >
                        <Box component="span" sx={{ fontWeight: 600 }}>/{command.key}</Box>
                        <Box component="span" sx={{ color: 'text.secondary' }}>{command.hint}</Box>
                      </Box>
                    ))}
                  </Box>
                )}
              </div>
            )}
            {view !== 'write' && (
              <Box
                id="editor-preview-pane"
                role="region"
                aria-label="预览"
                sx={view === 'split' ? {
                  minHeight: 560, borderTop: { xs: 1, xl: 0 }, borderLeft: { xs: 0, xl: 1 },
                  borderColor: 'divider', px: space.section, py: space.xl,
                } : { minHeight: 560, px: space.wide, py: space.section }}
              >
                <MarkdownContent content={body || '# 开始编写...'} compact />
              </Box>
            )}
          </Box>

          <Box component="footer" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, borderTop: 1, borderColor: 'divider', bgcolor: 'background.default', px: 2, py: 1, color: 'text.secondary', typography: 'metadata' }}>
            <span>{manualSaveRequired ? '待手动保存' : isDirty ? '未保存' : '已保存'}</span>
            <span aria-hidden>·</span>
            <span>⌘/Ctrl + S 保存</span>
            {showAutoStatus ? <Box component="span" sx={{ ml: 'auto' }}>{autoSaveLabel(autoSave.status)}</Box> : null}
            {existing?.aiAssisted ? <Box component="span" sx={{ ml: 'auto' }}>AI 协助产物，请在发布前核对来源</Box> : null}
          </Box>
        </Paper>

        <Box component="aside" sx={{
          position: { xs: mobilePanelOpen ? 'fixed' : 'relative', lg: 'sticky' },
          top: { xs: 'auto', lg: 2 },
          right: { xs: mobilePanelOpen ? 1.5 : 'auto', lg: 'auto' },
          bottom: { xs: mobilePanelOpen ? 1.5 : 'auto', lg: 'auto' },
          left: { xs: mobilePanelOpen ? 1.5 : 'auto', lg: 'auto' },
          zIndex: { xs: mobilePanelOpen ? 50 : 'auto', lg: 'auto' },
          display: { xs: mobilePanelOpen ? 'block' : 'none', lg: 'block' },
          maxHeight: { xs: mobilePanelOpen ? 'min(76vh, 680px)' : 'none', lg: 'none' },
          alignSelf: 'start',
        }}>
          <Paper variant="outlined" sx={{ display: 'flex', maxHeight: 'calc(100vh - 7rem)', minHeight: toolsCollapsed ? 0 : 420, flexDirection: 'column', overflow: 'hidden', borderColor: 'divider', bgcolor: 'background.paper', boxShadow: { xs: 'var(--dr-elevation-1)', lg: 'none' } }}>
            <Box sx={{ p: toolsCollapsed ? 0.75 : 1.5, pb: toolsCollapsed ? 0.75 : 0, borderBottom: 1, borderColor: 'divider' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: toolsCollapsed ? 'center' : 'space-between', px: toolsCollapsed ? 0 : 0.5, pb: toolsCollapsed ? 0 : 1 }}>
                {!toolsCollapsed ? <Typography variant="control" component="p" sx={{ fontWeight: 600 }}>研究工具</Typography> : <span className="sr-only">研究工具已收起</span>}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  {!toolsCollapsed ? <Typography variant="metadata" color="text.secondary">{outline.length} 节</Typography> : null}
                  <Button type="button" variant="ghost" size="icon-sm" sx={{ display: { xs: 'none', xl: 'inline-flex' } }} onClick={() => setToolsCollapsed((collapsed) => !collapsed)} aria-label={toolsCollapsed ? '展开研究工具' : '收起研究工具'} title={toolsCollapsed ? '展开研究工具' : '收起研究工具'}>{toolsCollapsed ? <PanelRightOpen /> : <PanelRightClose />}</Button>
                  {mobilePanelOpen ? <Button type="button" variant="ghost" size="icon-sm" sx={{ display: { lg: 'none' } }} onClick={() => setMobilePanelOpen(false)} aria-label="关闭研究工具"><X /></Button> : null}
                </Box>
              </Box>
              {!toolsCollapsed ? (
                <Box
                  sx={{ mb: '-1px', display: 'flex', minWidth: 0, overflowX: 'auto' }}
                  role="tablist"
                  aria-label="研究辅助面板"
                  onKeyDown={(e) => {
                    // 简易方向键支持:ArrowLeft/ArrowRight 在 tablist 中切换
                    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                    e.preventDefault();
                    const order = ['sources', 'assistant', 'details', 'versions'] as const;
                    const idx = order.indexOf(sidePanel);
                    const nextIdx = e.key === 'ArrowRight'
                      ? (idx + 1) % order.length
                      : (idx - 1 + order.length) % order.length;
                    setSidePanel(order[nextIdx] as typeof sidePanel);
                  }}
                >
                  {([
                    { key: 'sources', label: '来源与引用', panelId: 'side-panel-sources' },
                    { key: 'assistant', label: 'AI 助手', panelId: 'side-panel-assistant' },
                    { key: 'details', label: '文章信息', panelId: 'side-panel-details' },
                    { key: 'versions', label: '版本历史', panelId: 'side-panel-versions' },
                  ] as const).map((item) => (
                    <Button
                      key={item.key}
                      type="button"
                      role="tab"
                      aria-selected={sidePanel === item.key}
                      aria-controls={item.panelId}
                      title={item.label}
                      onClick={() => setSidePanel(item.key as typeof sidePanel)}
                      variant={sidePanel === item.key ? 'secondary' : 'ghost'}
                      size="xs"
                      sx={{
                        minWidth: 'max-content',
                        flex: '0 0 auto',
                        borderRadius: 0,
                        borderBottom: '2px solid',
                        borderColor: sidePanel === item.key ? 'primary.main' : 'transparent',
                        px: 1,
                        py: 1,
                        '&:hover': { borderColor: sidePanel === item.key ? 'primary.main' : 'divider' },
                      }}
                    >
                      {item.label}
                    </Button>
                  ))}
                </Box>
              ) : null}
            </Box>

            {!toolsCollapsed ? <Box sx={{ minHeight: 0, flex: '1 1 auto', overflowY: 'auto', p: 1.5 }}>
              {sidePanel === 'sources' && (
                <Box id="side-panel-sources" role="tabpanel" aria-label="来源与引用" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  <Typography variant="metadata" component="p" color="text.secondary">来源用于支撑正文中的判断；正文中的引用标记会连接到对应证据。</Typography>
                  {selectedText && view !== 'preview' && (
                    <Paper variant="outlined" sx={{ p: 1.25, bgcolor: 'action.hover' }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: 'text.primary', typography: 'metadata', fontWeight: 600 }}><Quote size={14} />选文工具</Box>
                      <Typography variant="metadata" component="p" color="text.secondary" sx={{ mt: 1, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, overflow: 'hidden' }}>“{selectedText}”</Typography>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1.5 }}>
                        <Button type="button" size="xs" variant="outline" onClick={copySelectedQuote}><Quote />复制引用</Button>
                        <Button type="button" size="xs" variant="ghost" onClick={() => insertBlock(`> ${selectedText.replace(/\n/g, '\n> ')}`)} disabled={isPublishedAi}><Link2 />插入正文</Button>
                      </Box>
                      {sources.length > 0 && <Typography variant="metadata" component="p" color="text.secondary" sx={{ mt: 1.5 }}>请在下方来源卡片中选择要关联的证据。</Typography>}
                      {flashMessage && <Typography variant="metadata" component="p" color="success.main" sx={{ mt: 1.5 }}>{flashMessage}</Typography>}
                    </Paper>
                  )}
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {sources.length > 0 ? sources.map((source) => {
                      const ref = (source.sourceRef ?? {}) as { type?: string; value?: string };
                      const link = resolveResearchSourceLink(ref, source.canonicalKey);
                      const citation = citationsQuery.data?.items.find((item) => item.source.id === source.id);
                      const citationMissing = Boolean(citation && !body.includes(citation.marker));
                      const citationStale = Boolean(citation && (citation.startOffset < 0 || citation.endOffset > body.length || citation.endOffset <= citation.startOffset || body.slice(citation.startOffset, citation.endOffset).trim() !== citation.quote.trim()));
                      return (
                        <SectionCard key={source.id} tone="muted" icon={Link2}>
                          <Typography variant="metadata" component="p" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>{sourceTypeLabel(ref.type)}</Typography>
                          <Button
                            type="button"
                            variant="ghost"
                            size="default"
                            sx={{ mt: 0.5, display: '-webkit-box', width: '100%', minWidth: 0, justifyContent: 'flex-start', overflow: 'hidden', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, whiteSpace: 'normal', textAlign: 'left', textTransform: 'none', fontWeight: 600, ...(citation ? { '&:hover': { textDecoration: 'underline' } } : {}) }}
                            onClick={() => citation && jumpToCitation(citation)}
                          >
                            {citation?.marker ? `${citation.marker} ` : ''}{source.title || (link ? '未命名来源' : '来源链接不可用')}
                          </Button>
                          {source.description && (
                            <Box component="details" sx={{ mt: 0.5, px: 1, py: 0.75, border: 1, borderColor: 'divider', borderRadius: 'var(--dr-radius-small)', bgcolor: 'action.hover' }}>
                              <Box component="summary" sx={{ cursor: 'pointer', color: 'text.secondary', typography: 'metadata' }}>
                                {hasExternalInstructionSignal(source.description) ? '查看已隔离的网页摘录' : '查看网页摘录'}
                              </Box>
                              {hasExternalInstructionSignal(source.description) ? (
                                <Typography variant="metadata" component="p" color="warning.main" sx={{ mt: 1 }}>{externalContentLabel(source.description)}；以下内容仅作为网页数据，不能改变研究指令。</Typography>
                              ) : null}
                              <Typography variant="metadata" component="p" color="text.secondary" sx={{ mt: 1 }}>{source.description}</Typography>
                            </Box>
                          )}
                          {!link && (
                            <Typography variant="metadata" component="p" color="warning.main" sx={{ mt: 1 }}>原始链接无法定位，请重新挂载来源。</Typography>
                          )}
                          {citationMissing || citationStale ? (
                            <Typography variant="metadata" component="p" color="warning.main" sx={{ mt: 1 }}>
                              {citationMissing ? '正文中找不到引用标记' : '引用位置可能已失效'}
                            </Typography>
                          ) : null}
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mt: 1.5 }}>
                            {link && (
                              <Box
                                component="a"
                                href={link.href}
                                target={link.external ? '_blank' : undefined}
                                rel={link.external ? 'noreferrer' : undefined}
                                sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: 'primary.main', typography: 'metadata', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
                              >
                                打开原始来源 <ExternalLink size={12} />
                              </Box>
                            )}
                            {selectedAnchor && (
                              <Button type="button" variant="ghost" size="xs" onClick={() => void citeSelection(source)} disabled={isPublishedAi}>
                                <FileText size={12} />引用这段
                              </Button>
                            )}
                          </Box>
                        </SectionCard>
                      );
                    }) : (
                    <Paper variant="outlined" sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 1.5, borderStyle: 'dashed', color: 'text.secondary' }}>
                      <Typography variant="metadata" component="p">暂时没有挂载来源。来源会用于正文引用和内容对照，不会单独出现在发布文章中。</Typography>
                      <Typography variant="metadata" component="p">
                        添加路径：在「AI 助手」标签里选择「补充来源」即可让模型基于当前正文去搜索并挂载候选来源。
                      </Typography>
                    </Paper>
                  )}
                  </Box>
                </Box>
              )}

              {sidePanel === 'assistant' && (
                <Box id="side-panel-assistant" role="tabpanel" aria-label="AI 助手" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, color: 'text.secondary' }}>
                  <Typography variant="control" component="p" color="text.primary" sx={{ fontWeight: 600 }}>AI 助手</Typography>
                  <Typography variant="metadata" component="p">先选中正文，再选择你要完成的任务。AI 只提供建议或核验结果，接受后才会改动正文。</Typography>
                  {assistantError ? (
                    <Alert role="alert" severity="error" sx={{ py: 0.25 }}>
                      <Typography variant="metadata" component="p">{assistantError}</Typography>
                      {!assistantBusy && assistantOperation ? (
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mt: 1 }}>
                          <Button type="button" size="xs" variant="outline" onClick={() => void runAssistant(assistantOperation)}>重试</Button>
                          <Typography variant="metadata" color="text.secondary">失败不会改动正文。</Typography>
                        </Box>
                      ) : null}
                    </Alert>
                  ) : null}
                  {selectedText ? <Paper variant="outlined" sx={{ p: 1.5, borderColor: 'primary.light', bgcolor: 'action.selected' }}><Typography variant="metadata" component="p" color="primary.main" sx={{ fontWeight: 600 }}>当前选文</Typography><Typography variant="body2" component="p" sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>{selectedText}</Typography></Paper> : null}
                  <Box sx={{ display: 'grid', gap: 1 }}>
                    {([
                      { op: 'rewrite' as const, label: '改写得更清晰', hint: '重写当前段落,保持原意但更易读' },
                      { op: 'summarize' as const, label: '总结这段', hint: '压缩成简短摘要' },
                      { op: 'counterpoint' as const, label: '补充反方观点', hint: '生成与本文相反的论证' },
                      { op: 'fact_check' as const, label: '检查事实', hint: '逐句核对引用与来源' },
                      { op: 'conclusion_check' as const, label: '核验结论', hint: '检查结论是否被证据支持' },
                    ]).map(({ op: operation, label, hint }) => (
                      <Button
                        key={operation}
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!selectedText || assistantBusy}
                        onClick={() => void runAssistant(operation)}
                        title={hint}
                        aria-label={`${label}:${hint}`}
                        sx={{ justifyContent: 'flex-start', gap: 0.75 }}
                      >
                        {assistantBusy ? '处理中…' : label}
                      </Button>
                    ))}
                  </Box>
                  {assistantBusy ? <Button type="button" size="xs" variant="ghost" onClick={cancelAssistant}>取消本次请求</Button> : null}
                  {assistantResult ? (
                    <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'action.hover' }}>
                      <Typography variant="control" component="p" sx={{ fontWeight: 600 }}>建议预览</Typography>
                      <Box sx={{ display: 'grid', gap: 1 }}>
                        <Box>
                          <Typography variant="metadata" color="error.main" sx={{ fontWeight: 600 }}>原文</Typography>
                          <Alert severity="error" icon={false} sx={{ mt: 0.5, py: 0.5 }}><Typography variant="metadata" component="p" sx={{ whiteSpace: 'pre-wrap' }}>{assistantResult.original}</Typography></Alert>
                        </Box>
                        {assistantResult.suggestion ? <Box><Typography variant="metadata" color="success.main" sx={{ fontWeight: 600 }}>建议</Typography><Alert severity="success" icon={false} sx={{ mt: 0.5, py: 0.5 }}><Typography variant="metadata" component="p" sx={{ whiteSpace: 'pre-wrap' }}>{assistantResult.suggestion}</Typography></Alert></Box> : null}
                    </Box>
                      {assistantResult.claims.length > 0 ? <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1.5 }}>{assistantResult.claims.map((claim) => <Typography key={claim.text} variant="metadata"><Box component="span" sx={{ fontWeight: 600 }}>[{claim.verdict}]</Box> {claim.text}{claim.evidence ? ` · ${claim.evidence}` : ''}</Typography>)}</Box> : null}
                      <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
                        {assistantResult.suggestion ? <Button type="button" size="xs" onClick={acceptAssistant} disabled={isPublishedAi}>接受建议</Button> : null}
                        <Button type="button" size="xs" variant="ghost" onClick={() => setAssistantResult(null)}>放弃</Button>
                      </Box>
                    </Paper>
                  ) : null}
                  {!selectedText && <Typography variant="metadata">未选中文本。</Typography>}
                </Box>
              )}

              {sidePanel === 'versions' && (
                <Box id="side-panel-versions" role="tabpanel" aria-label="版本历史" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {(existing?.audits ?? []).map((audit) => (
                    <Paper key={audit.id} variant="outlined" sx={{ p: 1.5 }}>
                      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                        <Typography variant="metadata" sx={{ fontWeight: 600 }}>{auditActionLabel(audit.action)}</Typography>
                              <Typography variant="metadata" color="text.secondary" sx={{ textAlign: 'right' }}>{new Date(audit.createdAt).toLocaleString('zh-CN')}</Typography>
                      </Box>
                      <Typography variant="metadata" component="p" color="text.secondary" sx={{ mt: 0.5 }}>{audit.editor.name}</Typography>
                      {audit.sourceIntent === 'revise' ? (
                        <Box sx={{ mt: 1.5, p: 1, border: 1, borderColor: 'primary.light', borderRadius: 'var(--dr-radius-small)', bgcolor: 'action.hover' }}>
                          <Typography variant="metadata" color="primary.main" sx={{ fontWeight: 600 }}>来自追问修订</Typography>
                          {audit.sourceQuestion ? <Typography variant="metadata" component="p" color="text.secondary" sx={{ mt: 0.5 }}>“{audit.sourceQuestion}”</Typography> : null}
                          {audit.reason ? <Typography variant="metadata" component="p" color="text.secondary" sx={{ mt: 0.5 }}>{audit.reason}</Typography> : null}
                        </Box>
                      ) : null}
                      {auditDiffEntries(audit.diff).length > 0 ? (
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 1.5 }}>
                          {auditDiffEntries(audit.diff).slice(0, 3).map((entry) => (
                            <Box key={entry.field} sx={{ p: 1, borderRadius: 'var(--dr-radius-small)', bgcolor: 'action.hover' }}>
                              <Typography variant="metadata" sx={{ fontWeight: 600 }}>{entry.field}</Typography>
                              <Typography variant="metadata" component="div" color="text.secondary" sx={{ mt: 0.5, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}><Box component="span" sx={{ color: 'error.main', fontWeight: 600 }}>前：</Box>{entry.from}</Typography>
                              <Typography variant="metadata" component="div" color="text.secondary" sx={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}><Box component="span" sx={{ color: 'success.main', fontWeight: 600 }}>后：</Box>{entry.to}</Typography>
                            </Box>
                          ))}
                        </Box>
                      ) : <Typography variant="metadata" component="p" color="text.secondary" sx={{ mt: 1.5 }}>状态记录，无字段差异。</Typography>}
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        sx={{ mt: 1.5 }}
                        disabled={!audit.prevSnapshot || isPublishedAi}
                        onClick={() => setRestoreConfirmAudit(audit)}
                      >
                        <RotateCcw />恢复
                      </Button>
                    </Paper>
                  ))}
                  {!existing?.audits?.length && <Typography variant="metadata" color="text.secondary">还没有版本记录。</Typography>}
                </Box>
              )}

              {sidePanel === 'details' && (
                <Box id="side-panel-details" role="tabpanel" aria-label="文章信息" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Typography variant="metadata" component="p" color="text.secondary">补充文章摘要和标签。保存草稿不受发布状态影响。</Typography>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                    <Typography variant="control" component="p" color="text.secondary" sx={{ fontWeight: 600 }}>研究摘要</Typography>
                    {(
                      [
                        { id: 'bg', label: '背景', value: background, set: setBackground, ph: '调研背景…' },
                        { id: 'cc', label: '结论', value: conclusion, set: setConclusion, ph: '调研结论…' },
                        { id: 'rk', label: '风险', value: risks, set: setRisks, ph: '风险与待验证项…' },
                      ] as const
                    ).map((f) => (
                      <Box key={f.id} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                        <Typography variant="metadata" component="label" htmlFor={`edit-${f.id}`} color="text.secondary">{f.label}</Typography>
                        <Textarea id={`edit-${f.id}`} value={f.value} onChange={(e) => f.set(e.target.value)} readOnly={isPublishedAi} rows={3} placeholder={f.ph} />
                      </Box>
                    ))}
                    </Box>
                  <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
                    <Paper variant="outlined" sx={{ p: 1.5, borderColor: publicationStatus.tone === 'success' ? 'var(--dr-color-success)' : 'var(--dr-color-warning)', bgcolor: publicationStatus.tone === 'success' ? 'var(--dr-color-success-container)' : 'var(--dr-color-warning-container)' }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                        <Typography variant="metadata" color="text.secondary" sx={{ fontWeight: 600 }}>发布状态</Typography>
                        <Typography variant="metadata" sx={{ color: publicationStatus.tone === 'success' ? 'var(--dr-color-success)' : 'var(--dr-color-warning)', fontWeight: 600 }}>{publicationStatus.label}</Typography>
                      </Box>
                      <Typography variant="metadata" component="p" color="text.secondary" sx={{ mt: 1 }}>{publicationStatus.detail}</Typography>
                      {existing?.status === 'draft' && reviewRequired && !reviewPublishable && summaryComplete && (
                        <Button type="button" variant="outline" size="sm" sx={{ mt: 1.5, width: '100%', bgcolor: 'background.paper' }} onClick={handleReview} disabled={reviewDisabled}>
                          <RotateCcw />
                          {reviewMutation.isPending || reviewInProgress ? '正在检查…' : currentReviewIsCurrent ? '重新检查资料' : '检查当前稿'}
                        </Button>
                      )}
                      {reviewRequired && (
                        <Box component="details" sx={{ mt: 1.5, pt: 1.25, borderTop: 1, borderColor: 'divider' }}>
                          <Box component="summary" sx={{ cursor: 'pointer', color: 'text.secondary', typography: 'metadata', '&:hover': { color: 'text.primary' } }}>查看依据详情</Box>
                          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 1, color: 'text.secondary' }}>
                            <Typography variant="metadata">资料覆盖：{researchCoverageLabel === '已满足' ? '已覆盖关键部分' : researchCoverageLabel === '不足' ? '还有缺口' : '暂未判断'}</Typography>
                            <Typography variant="metadata">可核对来源：{sources.length} 条</Typography>
                            {publicationGate?.status === 'publish_with_disclosure' ? <Typography variant="metadata">发布后会保留 {publicationGate.disclosedCount} 条不确定性提示。</Typography> : null}
                            {currentReviewIsCurrent ? <Typography variant="metadata">以上状态对应当前正文版本。</Typography> : <Typography variant="metadata">正文有过修改，以上状态尚未更新。</Typography>}
                          </Box>
                        </Box>
                      )}
                    </Paper>
                  </Box>
                  <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
                    <Typography variant="metadata" component="label" htmlFor="edit-tags" color="text.secondary" sx={{ fontWeight: 600 }}>标签</Typography>
                    <Input id="edit-tags" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} readOnly={isPublishedAi} placeholder="例如: React, TypeScript, 架构" sx={{ mt: 1.5 }} />
                    {tags.length > 0 && <Box sx={{ mt: 0.5 }}><TagList>{tags.map((t) => <TagChip key={t}>{t}</TagChip>)}</TagList></Box>}
                    <Typography variant="metadata" component="p" color="text.secondary" sx={{ mt: 1.5 }}>用逗号分隔，建议保留 2–5 个检索词。</Typography>
                  </Box>
                </Box>
              )}
            </Box> : null}
          </Paper>
          {!toolsCollapsed ? <Box component="button"
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
            sx={{ position: 'absolute', top: 0, left: -8, display: { xs: 'none', xl: 'block' }, width: 16, height: '100%', cursor: 'col-resize', border: 0, p: 0, bgcolor: 'transparent', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 }, '&:hover > span': { bgcolor: 'divider' } }}
          ><Box component="span" sx={{ display: 'block', width: '1px', height: '100%', mx: 'auto', bgcolor: 'transparent', transition: 'background-color var(--dr-motion-fast)' }} /></Box> : null}
        </Box>
      </Box>
      <Dialog open={publishConfirmOpen} onClose={() => setPublishConfirmOpen(false)} fullWidth maxWidth="sm" aria-labelledby="publish-confirm-title">
        <DialogTitle id="publish-confirm-title">
          <Typography variant="panelTitle" component="h2">确认发布调研？</Typography>
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
              发布后团队成员可以阅读和评论。{publicationGate?.status === 'publish_with_disclosure'
                ? `当前版本保留 ${publicationGate.disclosedCount} 条已接受的不确定性，请确认它们已反映在风险或后续行动中。`
                : publicationGate?.status === 'clear' && researchCoverageLabel === '未评估'
                  ? '关键依据已有，但资料范围没有自动评估；请确认当前资料确实足以回答原始问题。'
                : '请确认结论、证据和风险已核对。'}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
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
        </DialogActions>
      </Dialog>
      <AppDialog
        open={Boolean(restoreConfirmAudit)}
        onClose={() => setRestoreConfirmAudit(null)}
        title="确认恢复历史版本？"
        description="恢复该版本会覆盖当前未保存的修改,确认继续?"
        actions={(
          <>
            <Button type="button" variant="outline" onClick={() => setRestoreConfirmAudit(null)}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => {
                const audit = restoreConfirmAudit;
                setRestoreConfirmAudit(null);
                if (audit) void restoreAudit(audit);
              }}
            >
              确认恢复
            </Button>
          </>
        )}
      />
      {confirmDialog}
    </Box>
  );
}

type EditorButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
type EditorButtonSize = 'default' | 'sm' | 'xs' | 'lg' | 'icon' | 'icon-sm';

interface EditorButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: EditorButtonVariant;
  size?: EditorButtonSize;
  sx?: SxProps<Theme>;
}

/** Preserve the editor's button call sites while rendering with the shared MUI theme. */
const Button = forwardRef<HTMLButtonElement, EditorButtonProps>(function Button({
  variant = 'default',
  size = 'default',
  className,
  sx,
  ...props
}, ref) {
  const muiVariant = variant === 'outline' ? 'outlined' : variant === 'ghost' || variant === 'link' ? 'text' : 'contained';
  const color = variant === 'destructive' ? 'error' : variant === 'ghost' || variant === 'outline' || variant === 'secondary' ? 'inherit' : 'primary';
  const sizeSx: SxProps<Theme> = {
    ...(size === 'xs' ? { '@media (pointer: fine)': { minHeight: 28, px: 1, py: 0.5 } } : {}),
    ...(size === 'sm' ? { '@media (pointer: fine)': { minHeight: 32, px: 1.5, py: 0.5 } } : {}),
    ...(size === 'lg' ? { minHeight: 'var(--dr-touch-target)', px: 3 } : {}),
    ...(size === 'icon' || size === 'icon-sm' ? {
      width: 'var(--dr-control-height)',
      minWidth: 'var(--dr-control-height)',
      px: 0,
      gap: 0,
    } : {}),
    ...(size === 'icon' ? { minHeight: 'var(--dr-control-height)' } : {}),
    ...(variant === 'secondary' ? {
      bgcolor: 'action.selected',
      color: 'text.primary',
      '&:hover': { bgcolor: 'action.focus' },
    } : {}),
    ...(variant === 'link' ? { minHeight: 'auto', px: 0, textDecoration: 'underline', textUnderlineOffset: 3 } : {}),
  };

  return (
    <MaterialButton
      ref={ref}
      {...props}
      className={className}
      variant={muiVariant}
      color={color}
      size={size === 'default' || size === 'lg' ? 'medium' : 'small'}
      sx={sx ? [sizeSx, ...(Array.isArray(sx) ? sx : [sx])] : sizeSx}
    />
  );
});

const editorTextareaSx: SxProps<Theme> = {
  display: 'block',
  boxSizing: 'border-box',
  width: '100%',
  maxWidth: '100%',
  px: 1.5,
  py: 1.25,
  border: '1px solid',
  borderColor: 'text.disabled',
  borderRadius: 'var(--dr-radius-small)',
  bgcolor: 'background.paper',
  color: 'text.primary',
  fontFamily: 'inherit',
  fontSize: 'var(--dr-type-body)',
  lineHeight: 'var(--dr-line-height-body)',
  resize: 'vertical',
  '&::placeholder': { color: 'text.disabled', opacity: 1 },
  '&:hover': { borderColor: 'text.secondary' },
  '&:focus-visible': { outline: '2px solid var(--dr-color-primary)', outlineOffset: 2, borderColor: 'primary.main' },
  '&:read-only': { bgcolor: 'action.hover' },
};

interface EditorTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  sx?: SxProps<Theme>;
}

/** A MUI-system styled native textarea; keeping the actual textarea preserves selection APIs and undo. */
const Textarea = forwardRef<HTMLTextAreaElement, EditorTextareaProps>(function Textarea({ sx, ...props }, ref) {
  return (
    <Box
      component="textarea"
      ref={ref}
      {...props}
      sx={sx ? [editorTextareaSx, ...(Array.isArray(sx) ? sx : [sx])] : editorTextareaSx}
    />
  );
});

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
