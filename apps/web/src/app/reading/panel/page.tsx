'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Bookmark, Check, Languages, Loader2, MessageCircle, Send, Sparkles, X } from 'lucide-react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { space } from '@deep-research/design-system';

type Anchor = {
  quote: string;
  prefix?: string;
  suffix?: string;
  startOffset?: number;
  endOffset?: number;
  contentHash?: string;
  selectorPath?: string;
};

type ReadingContext = {
  url: string;
  title: string;
  language?: string;
  body: string;
  section?: string;
  scope?: 'selection' | 'section' | 'page';
  selection?: Anchor;
  translatedBlockIds?: string[];
  translationDetected?: boolean;
};

type Block = { id: string; text: string };
type Message = { role: 'user' | 'assistant'; content: string };
type ReadingAnswer = {
  background?: string;
  inference?: string;
  limitations?: string[];
  evidence?: Array<{ quote: string; claim?: string; anchor?: Anchor }>;
  warnings?: string[];
};

// Only post to the embedding page's actual origin; never broadcast with '*'.
function parentOrigin(): string | null {
  const ancestor = window.location.ancestorOrigins?.[0];
  if (ancestor && ancestor !== 'null') return ancestor;
  try { return new URL(document.referrer).origin; } catch { return null; }
}

const panelMessage = (payload: unknown) => {
  const target = parentOrigin();
  if (target) window.parent.postMessage(payload, target);
};

function apiReadingContext(context: ReadingContext): Omit<ReadingContext, 'translatedBlockIds' | 'translationDetected'> {
  const { translatedBlockIds: _translatedBlockIds, translationDetected: _translationDetected, ...safeContext } = context;
  return safeContext;
}

function readingToken(): string | null {
  return new URLSearchParams(window.location.search).get('token')
    || window.sessionStorage.getItem('deep-research-reader-token');
}

function readingHeaders(): HeadersInit {
  const params = new URLSearchParams(window.location.search);
  const token = readingToken();
  if (params.has('token') && token) {
    window.sessionStorage.setItem('deep-research-reader-token', token);
    window.history.replaceState(null, '', `${window.location.pathname}?embedded=1`);
  }
  return token ? { 'content-type': 'application/json', authorization: `Bearer ${token}` } : { 'content-type': 'application/json' };
}

export default function ReadingPanelPage() {
  const [context, setContext] = useState<ReadingContext | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [answer, setAnswer] = useState('');
  const [readingAnswer, setReadingAnswer] = useState<ReadingAnswer | null>(null);
  const [quoteOverride, setQuoteOverride] = useState('');
  const [history, setHistory] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState('');
  const [discussionScope, setDiscussionScope] = useState<'selection' | 'page'>('selection');
  const [pendingAction, setPendingAction] = useState<'translate' | 'explain' | 'ask' | 'save' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'translate' | 'explain' | 'ask' | 'save' | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saveKey, setSaveKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [anchorNotice, setAnchorNotice] = useState('');
  const [translationFailures, setTranslationFailures] = useState<string[]>([]);
  const [translationSelectionOnly, setTranslationSelectionOnly] = useState(false);
  const [bilingualEnabled, setBilingualEnabled] = useState(false);
  const [bilingualPaused, setBilingualPaused] = useState(false);
  // A block is marked once a translation response (success or partial
  // failure) has been received. This keeps scrolling from re-sending the same
  // viewport to the model; failed blocks remain visible in the retry banner.
  const [translatedBlockIds, setTranslatedBlockIds] = useState<Set<string>>(() => new Set());
  const [tokenPresent, setTokenPresent] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const pageUrlRef = useRef<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('reader-embedded');
    // Keep the one-time handoff token out of the iframe URL and referrer logs.
    const token = new URLSearchParams(window.location.search).get('token');
    if (token) {
      window.sessionStorage.setItem('deep-research-reader-token', token);
      window.history.replaceState(null, '', `${window.location.pathname}?embedded=1`);
    }
    setTokenPresent(Boolean(token || window.sessionStorage.getItem('deep-research-reader-token')));
    const normalizeContext = (value: Record<string, unknown>): ReadingContext => {
      const { blocks: _blocks, ...readingContext } = value;
      return readingContext as ReadingContext;
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'deep-research:clear-page') {
        setContext(null);
        setBlocks([]);
        setAnswer('');
        setReadingAnswer(null);
        setHistory([]);
        setQuoteOverride('');
        setSaved(null);
        setSaveKey(null);
        setError('');
        setAnchorNotice('');
        setTranslationFailures([]);
        setTranslationSelectionOnly(false);
        setBilingualEnabled(false);
        setBilingualPaused(false);
        setTranslatedBlockIds(new Set());
        pageUrlRef.current = null;
        return;
      }
      if (data.type === 'deep-research:anchor-unresolved') {
        setAnchorNotice(typeof data.reason === 'string' ? data.reason : '原文已变化，无法准确定位');
        return;
      }
      if (data.type === 'deep-research:anchor-resolved') {
        setAnchorNotice('已回到原文证据');
        window.setTimeout(() => setAnchorNotice(''), 2200);
        return;
      }
      if (data.type === 'deep-research:translations-restored') {
        setTranslationFailures([]);
        setBilingualEnabled(false);
        setBilingualPaused(false);
        setTranslatedBlockIds(new Set());
        return;
      }
      if (data.type === 'deep-research:viewport-blocks') {
        setBlocks(Array.isArray(data.blocks) ? data.blocks : []);
        return;
      }
      if (data.type === 'deep-research:selection-action') {
        const action = data.action;
        if (action === 'translate' || action === 'explain' || action === 'ask' || action === 'save') setPendingAction(action);
        return;
      }
      if (data.type === 'deep-research:selection' && data.context) {
        const nextContext = normalizeContext(data.context as Record<string, unknown>);
        setContext(nextContext);
        setDiscussionScope('selection');
        setQuoteOverride(nextContext.selection?.quote || nextContext.body.slice(0, 800));
        setAnswer('');
        setReadingAnswer(null);
        setError('');
        setAnchorNotice('');
        setSaved(null);
        setSaveKey(makeSaveKey());
        setTranslationFailures([]);
        setTranslationSelectionOnly(false);
      }
      if (data.type === 'deep-research:page-context' && data.context) {
        const nextContext = normalizeContext(data.context as Record<string, unknown>);
        if (nextContext.url !== pageUrlRef.current) {
          pageUrlRef.current = nextContext.url;
          setBilingualEnabled(false);
          setBilingualPaused(false);
          setTranslatedBlockIds(new Set(nextContext.translatedBlockIds || []));
          setTranslationFailures([]);
        } else if (Array.isArray(nextContext.translatedBlockIds)) {
          // The content script reports all currently inserted translations,
          // including blocks outside the viewport. Replace the local set so
          // tab switches do not cause already-rendered paragraphs to be sent
          // to the model again.
          setTranslatedBlockIds(new Set(nextContext.translatedBlockIds));
        }
        setContext(nextContext);
        setQuoteOverride((current) => current || nextContext.selection?.quote || nextContext.body.slice(0, 800));
        setBlocks(Array.isArray(data.blocks) ? data.blocks : []);
      }
    };
    window.addEventListener('message', onMessage);
    panelMessage({ type: 'deep-research:ready' });
    panelMessage({ type: 'deep-research:request-page' });
    return () => {
      window.removeEventListener('message', onMessage);
      document.documentElement.classList.remove('reader-embedded');
      activeRequest.current?.abort();
    };
  }, []);

  const displayQuote = context?.selection?.quote || context?.body.slice(0, 800) || '';
  const scopeLabel = context?.selection && discussionScope !== 'page' ? '当前选段' : '当前页面';
  const sourceNotice = context ? sourceScopeNotice(context.url) : null;
  const canAsk = Boolean(context && prompt.trim() && !busy);

  async function callAnswer(action: 'explain' | 'ask') {
    if (!context) return;
    setBusy(action);
    setError('');
    setReadingAnswer(null);
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const response = await fetch('/api/reading/answer/stream', {
        method: 'POST',
        headers: { ...readingHeaders(), accept: 'text/event-stream' },
        body: JSON.stringify({
          action,
          context: { ...apiReadingContext(context), scope: action === 'explain' ? (context.selection ? 'selection' : 'page') : (context.selection ? discussionScope : 'page') },
          prompt: action === 'ask' ? prompt.trim() : undefined,
          history: history.slice(-10).map((item) => ({ ...item, content: item.content.slice(0, 8_000) })),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'AI 暂时不可用');
      }
      if (!response.body) throw new Error('阅读回答没有返回可读取的内容');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamedAnswer = '';
      const consumeFrame = (frame: string) => {
        const event = frame.match(/^event:\s*(\S+)/m)?.[1] || '';
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!data) return;
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (event === 'delta' && typeof parsed.text === 'string') {
          streamedAnswer += parsed.text;
          setAnswer(streamedAnswer);
        } else if (event === 'error') {
          throw new Error(typeof parsed.message === 'string' ? parsed.message : 'AI 暂时不可用');
        } else if (event === 'done') {
          const completed = typeof parsed.answer === 'string'
            ? parsed.answer
            : typeof parsed.suggestion === 'string' ? parsed.suggestion : '';
          if (completed) {
            streamedAnswer = completed;
            setAnswer(streamedAnswer);
          }
          if (parsed.reading && typeof parsed.reading === 'object') setReadingAnswer(parsed.reading as ReadingAnswer);
        }
      };
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        frames.forEach(consumeFrame);
        if (chunk.done) break;
      }
      if (buffer.trim()) consumeFrame(buffer);
      if (!streamedAnswer) throw new Error('AI 没有生成有效回答，请重试');
      setHistory((items) => [
        ...items,
        ...(action === 'ask' ? [{ role: 'user' as const, content: prompt.trim() }] : []),
        { role: 'assistant', content: streamedAnswer },
      ]);
      if (action === 'ask') setPrompt('');
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setError(err instanceof Error ? err.message : '请求失败，请重试');
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      setBusy(null);
    }
  }

  async function translatePage(retryIds?: string[], selectionOnly = false) {
    if (!context) return;
    if (context.translationDetected) {
      setError('检测到页面已有其他翻译插件内容，请先选择一个翻译器，避免重复插入。');
      return;
    }
    setTranslationSelectionOnly(selectionOnly);
    setBusy('translate');
    setError('');
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const allBlocks = selectionOnly
        ? [{ id: 'selection', text: displayQuote }]
        : blocks.length > 0 ? blocks : [{ id: 'selection', text: displayQuote }];
      const filteredBlocks = retryIds && retryIds.length > 0
        ? allBlocks.filter((block) => retryIds.includes(block.id))
        : allBlocks;
      const sourceBlocks = filteredBlocks.length > 0 ? filteredBlocks : allBlocks;
      const response = await fetch('/api/reading/translate', {
        method: 'POST',
        headers: readingHeaders(),
        body: JSON.stringify({ url: context.url, title: context.title, language: context.language || 'zh-CN', blocks: sourceBlocks }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '翻译失败');
      const translations = Array.isArray(payload.translations) ? payload.translations : [];
      setTranslationFailures(translations.filter((item: { id?: unknown; text?: unknown }) => !item.text && typeof item.id === 'string').map((item: { id: string }) => item.id));
      setTranslatedBlockIds((previous) => {
        const next = new Set(previous);
        translations.forEach((item: { id?: unknown }) => {
          if (typeof item.id === 'string') next.add(item.id);
        });
        return next;
      });
      if (!selectionOnly) setBilingualEnabled(true);
      panelMessage({ type: 'deep-research:apply-translations', translations });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setError(err instanceof Error ? err.message : '翻译失败，请重试');
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      setBusy(null);
    }
  }

  // Once the user enables bilingual reading, translate only newly visible
  // blocks. The content script also guards duplicate DOM insertion, but the
  // client-side set avoids paying for duplicate model calls in the first
  // place. A failed block stays marked until the user explicitly retries it.
  useEffect(() => {
    if (!bilingualEnabled || bilingualPaused || !context || busy || blocks.length === 0) return;
    const pending = blocks
      .filter((block) => !translatedBlockIds.has(block.id))
      .map((block) => block.id);
    if (pending.length > 0) void translatePage(pending, false);
  }, [blocks, bilingualEnabled, bilingualPaused, context, busy, translatedBlockIds]);

  function translateVisibleBlocks() {
    setBilingualPaused(false);
    if (!bilingualEnabled) {
      void translatePage();
      return;
    }
    const pending = blocks
      .filter((block) => !translatedBlockIds.has(block.id))
      .map((block) => block.id);
    if (pending.length > 0) void translatePage(pending, false);
  }

  async function saveResult() {
    if (!context || saved) return;
    setBusy('save');
    setError('');
    const requestKey = saveKey || makeSaveKey();
    setSaveKey(requestKey);
    const quote = quoteOverride.trim() || displayQuote;
    const keepsAnchor = Boolean(context.selection && quote === context.selection.quote.trim());
    try {
      const response = await fetch('/api/reading/save', {
        method: 'POST',
        headers: readingHeaders(),
        body: JSON.stringify({
          url: context.url,
          title: context.title,
          quote,
          note,
          aiAnswer: answer || undefined,
          // An edited excerpt is still useful, but it no longer has a safe
          // exact location. Omitting the anchor makes that loss explicit and
          // prevents a later click from highlighting the wrong paragraph.
          anchor: keepsAnchor ? context.selection : undefined,
          tags: ['browser-reading'],
          idempotencyKey: requestKey,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '保存失败');
      setSaved(payload.draft?.id || 'saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请重试');
    } finally {
      setBusy(null);
    }
  }

  async function disconnectReader() {
    const token = readingToken();
    setDisconnecting(true);
    try {
      if (token) {
        await fetch('/api/reading/token/revoke', {
          method: 'POST',
          headers: readingHeaders(),
          signal: AbortSignal.timeout(8_000),
        });
      }
    } catch {
      // Local removal still protects this browser if the server is offline;
      // the server grant remains bounded by its normal expiry.
    } finally {
      window.sessionStorage.removeItem('deep-research-reader-token');
      panelMessage({ type: 'deep-research:disconnect' });
      setTokenPresent(false);
      setContext(null);
      setAnswer('');
      setReadingAnswer(null);
      setHistory([]);
      setSaved(null);
      setSaveKey(null);
      setBilingualEnabled(false);
      setBilingualPaused(false);
      setTranslatedBlockIds(new Set());
      setDisconnecting(false);
    }
  }

  useEffect(() => {
    if (!context || !pendingAction) return;
    setPendingAction(null);
    if (pendingAction === 'translate') void translatePage(undefined, true);
    else if (pendingAction === 'explain') void callAnswer('explain');
    else if (pendingAction === 'ask') document.getElementById('reader-prompt')?.focus();
    else document.getElementById('reader-quote')?.focus();
  }, [context, pendingAction]);

  const title = useMemo(() => context?.title || '打开一个网页后开始阅读', [context?.title]);

  return (
    <Box
      className="material-surface"
      sx={{
        minHeight: 'calc(100dvh - 8rem)',
        bgcolor: 'background.default',
        color: 'text.primary',
        fontFamily: 'var(--dr-font-family)',
        fontSize: 'var(--dr-type-body)',
        lineHeight: 'var(--dr-line-height-body)',
      }}
    >
      <Box sx={{ width: '100%', maxWidth: '42rem', mx: 'auto', px: { xs: space.lg, sm: space.section }, py: space.xl }}>
        <Stack direction="row" spacing={space.md} sx={{ mb: space.xl, alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={space.sm} sx={{ mb: space.sm, alignItems: 'center', color: 'primary.main' }}>
              <BookOpen size={14} aria-hidden />
              <Typography component="span" variant="caption" sx={{ fontWeight: 'var(--dr-weight-semibold)', letterSpacing: '0.18em', textTransform: 'uppercase' }}>
                Deep Research Reader
              </Typography>
            </Stack>
            <Typography component="h1" variant="panelTitle">{title}</Typography>
            {context && (
              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', mt: space.xs }}>
                {safeHostname(context.url)} · {scopeLabel}
              </Typography>
            )}
          </Box>
          <Stack direction="row" spacing={space.xs} sx={{ flexShrink: 0, alignItems: 'center' }}>
            {tokenPresent && (
              <Button size="small" variant="text" color="secondary" disabled={disconnecting} onClick={() => void disconnectReader()}>
                {disconnecting ? '断开中…' : '断开账号'}
              </Button>
            )}
            <IconButton aria-label="关闭侧栏" size="small" onClick={() => panelMessage({ type: 'deep-research:close' })}>
              <X size={16} />
            </IconButton>
          </Stack>
        </Stack>

        {!context ? (
          <Paper variant="outlined" sx={{ p: space.section }}>
            <Sparkles size={20} aria-hidden />
            <Typography variant="body2" color="text.secondary">
              点击浏览器工具栏的 Deep Research，再在网页中选择一段文字。插件只会在你发起操作时读取当前页面。
            </Typography>
            <Button variant="contained" sx={{ mt: space.lg }} onClick={() => panelMessage({ type: 'deep-research:connect' })}>
              连接 Deep Research 账号
            </Button>
          </Paper>
        ) : (
          <>
            <Paper variant="outlined" sx={{ p: space.lg }}>
              <Stack direction="row" sx={{ mb: space.sm, justifyContent: 'space-between' }}>
                <Typography variant="control" color="text.secondary">原文摘录</Typography>
                <Typography variant="caption" color="text.secondary">{context.selection ? '已锚定' : '页面上下文'}</Typography>
              </Stack>
              <Box
                component="blockquote"
                sx={{ borderLeft: 2, borderColor: 'primary.main', pl: space.md, color: 'text.secondary', lineHeight: 'var(--dr-line-height-reading)' }}
              >
                {displayQuote}
              </Box>
              {context.translationDetected && (
                <Alert severity="warning" sx={{ mt: space.md }}>
                  检测到页面已有其他翻译插件内容。为避免重复翻译，已暂停本插件的双语插入；请选择一个翻译器继续。
                </Alert>
              )}
              <Stack direction="row" useFlexGap spacing={space.sm} sx={{ mt: space.lg, flexWrap: 'wrap' }}>
                <ReaderAction disabled={Boolean(busy) || Boolean(context.translationDetected)} onClick={translateVisibleBlocks}>
                  <Languages size={14} aria-hidden />
                  {bilingualEnabled ? '继续翻译视口' : '开启双语'}
                </ReaderAction>
                {bilingualEnabled && (
                  <ReaderAction disabled={Boolean(busy)} onClick={() => setBilingualPaused((paused) => !paused)}>
                    <Languages size={14} aria-hidden />
                    {bilingualPaused ? '继续处理' : '暂停双语'}
                  </ReaderAction>
                )}
                <ReaderAction disabled={Boolean(busy)} onClick={() => panelMessage({ type: 'deep-research:restore-translations' })}>
                  <X size={14} aria-hidden />
                  恢复原文
                </ReaderAction>
                <ReaderAction disabled={Boolean(busy)} onClick={() => callAnswer('explain')}>
                  <Sparkles size={14} aria-hidden />
                  解读
                </ReaderAction>
                <ReaderAction disabled={Boolean(busy)} onClick={() => document.getElementById('reader-prompt')?.focus()}>
                  <MessageCircle size={14} aria-hidden />
                  追问
                </ReaderAction>
              </Stack>
              {translationFailures.length > 0 && (
                <Alert
                  severity="warning"
                  action={(
                    <Button
                      size="small"
                      color="inherit"
                      onClick={() => {
                        const failedIds = [...translationFailures];
                        setBilingualPaused(true);
                        setTranslatedBlockIds((previous) => {
                          const next = new Set(previous);
                          failedIds.forEach((id) => next.delete(id));
                          return next;
                        });
                        void translatePage(failedIds, translationSelectionOnly).finally(() => setBilingualPaused(false));
                      }}
                    >
                      重试失败段落
                    </Button>
                  )}
                  sx={{ mt: space.md }}
                >
                  {translationFailures.length} 段翻译失败
                </Alert>
              )}
            </Paper>

            <Paper variant="outlined" sx={{ mt: space.lg, p: space.lg }}>
              <Stack direction="row" spacing={space.sm} sx={{ mb: space.md, alignItems: 'center', justifyContent: 'space-between' }}>
                <Stack direction="row" spacing={space.sm} sx={{ alignItems: 'center' }}>
                  <MessageCircle size={16} aria-hidden />
                  <Typography component="h2" variant="listTitle">围绕原文讨论</Typography>
                </Stack>
                {context.selection && (
                  <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={discussionScope}
                    onChange={(_event, value: 'selection' | 'page' | null) => { if (value) setDiscussionScope(value); }}
                    aria-label="讨论范围"
                  >
                    <ToggleButton value="selection">当前选段</ToggleButton>
                    <ToggleButton value="page">问整页</ToggleButton>
                  </ToggleButtonGroup>
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: space.md }}>
                本轮范围：{discussionScope === 'page' || !context.selection ? '当前页面（已提取正文）' : '当前选段 + 所在小节'} · 回答会把原文证据与一般背景分开说明
              </Typography>
              {sourceNotice && (
                <Alert severity="info" sx={{ mb: space.md }}>{sourceNotice}</Alert>
              )}
              {anchorNotice && (
                <Alert severity="warning" sx={{ mb: space.md }}>{anchorNotice}</Alert>
              )}
              {answer && (
                <Box sx={{ mb: space.lg, p: space.md, borderRadius: 'var(--dr-radius-small)', bgcolor: 'var(--dr-color-evidence-container)' }}>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{answer}</Typography>
                  {context.selection && (
                    <Button
                      size="small"
                      variant="text"
                      sx={{ mt: space.md, px: 0, minHeight: 'auto' }}
                      onClick={() => panelMessage({ type: 'deep-research:focus-anchor', anchor: context.selection })}
                    >
                      回到原文证据
                    </Button>
                  )}
                </Box>
              )}
              {readingAnswer && (readingAnswer.evidence?.length || readingAnswer.background || readingAnswer.inference || readingAnswer.limitations?.length || readingAnswer.warnings?.length) ? (
                <Stack spacing={space.md} sx={{ mb: space.lg }}>
                  {readingAnswer.evidence?.length ? (
                    <Box>
                      <Typography variant="control" sx={{ display: 'block', mb: space.xs, fontWeight: 'var(--dr-weight-semibold)' }}>原文证据</Typography>
                      <Stack spacing={space.sm}>
                        {readingAnswer.evidence.map((item, index) => (
                          <Paper
                            key={`${item.quote}-${index}`}
                            variant="outlined"
                            component="button"
                            type="button"
                            onClick={() => item.anchor && panelMessage({ type: 'deep-research:focus-anchor', anchor: item.anchor })}
                            sx={{
                              display: 'block', width: '100%', p: space.md, textAlign: 'left', cursor: 'pointer',
                              borderColor: 'var(--dr-color-outline)', bgcolor: 'var(--dr-color-evidence-container)',
                              '&:hover': { borderColor: 'primary.main' },
                            }}
                          >
                            <Typography variant="body2" component="span" sx={{ display: 'block' }}>“{item.quote}”</Typography>
                            {item.claim && <Typography variant="caption" color="text.secondary" component="span" sx={{ display: 'block', mt: space.xs }}>{item.claim}</Typography>}
                          </Paper>
                        ))}
                      </Stack>
                    </Box>
                  ) : null}
                  {readingAnswer.background ? (
                    <Box sx={{ pt: space.sm, borderTop: 1, borderColor: 'divider' }}>
                      <Typography variant="control" sx={{ display: 'block', fontWeight: 'var(--dr-weight-semibold)' }}>必要背景</Typography>
                      <Typography variant="body2" sx={{ mt: space.xs, whiteSpace: 'pre-wrap' }}>{readingAnswer.background}</Typography>
                    </Box>
                  ) : null}
                  {readingAnswer.inference ? (
                    <Box sx={{ pt: space.sm, borderTop: 1, borderColor: 'divider' }}>
                      <Typography variant="control" sx={{ display: 'block', fontWeight: 'var(--dr-weight-semibold)' }}>AI 推断</Typography>
                      <Typography variant="body2" sx={{ mt: space.xs, whiteSpace: 'pre-wrap' }}>{readingAnswer.inference}</Typography>
                    </Box>
                  ) : null}
                  {readingAnswer.limitations?.length ? (
                    <Box sx={{ pt: space.sm, borderTop: 1, borderColor: 'divider' }}>
                      <Typography variant="control" sx={{ display: 'block', fontWeight: 'var(--dr-weight-semibold)' }}>适用条件与未知项</Typography>
                      <Box component="ul" sx={{ mt: space.xs, pl: space.lg, listStyle: 'disc' }}>
                        {readingAnswer.limitations.map((item, index) => (
                          <Typography component="li" variant="body2" key={`${item}-${index}`}>{item}</Typography>
                        ))}
                      </Box>
                    </Box>
                  ) : null}
                  {readingAnswer.warnings?.length ? (
                    <Alert severity="warning">{readingAnswer.warnings.join('；')}</Alert>
                  ) : null}
                </Stack>
              ) : null}
              <Stack direction="row" spacing={space.sm} sx={{ alignItems: 'stretch' }}>
                <TextField
                  id="reader-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter' && canAsk) void callAnswer('ask'); }}
                  placeholder="例如：这对系统设计有什么影响？"
                  size="small"
                  fullWidth
                  sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'var(--dr-color-surface-composer)' } }}
                />
                <IconButton
                  aria-label="发送问题"
                  disabled={!canAsk}
                  color="primary"
                  onClick={() => void callAnswer('ask')}
                  sx={{ borderRadius: 'var(--dr-radius-small)' }}
                >
                  <Send size={16} />
                </IconButton>
              </Stack>
              {busy && (
                <Stack direction="row" spacing={space.sm} sx={{ mt: space.md, alignItems: 'center' }}>
                  <CircularProgress size={14} aria-hidden />
                  <Typography variant="caption" color="text.secondary">
                    正在处理当前{busy === 'translate' ? '页面翻译' : busy === 'explain' ? 'AI 解读' : '问题'}…
                  </Typography>
                  <Button size="small" variant="text" sx={{ ml: 'auto', minHeight: 'auto', px: 0 }} onClick={() => activeRequest.current?.abort()}>
                    停止
                  </Button>
                </Stack>
              )}
              {error && (
                <Alert
                  severity="error"
                  action={<Button size="small" color="inherit" onClick={() => panelMessage({ type: 'deep-research:connect' })}>连接账号</Button>}
                  sx={{ mt: space.md }}
                >
                  {error}
                </Alert>
              )}
            </Paper>

            <Paper variant="outlined" sx={{ mt: space.lg, p: space.lg }}>
              <Stack direction="row" spacing={space.sm} sx={{ mb: space.md, alignItems: 'center' }}>
                <Bookmark size={16} aria-hidden />
                <Typography component="h2" variant="listTitle">保存阅读成果</Typography>
              </Stack>
              <TextField
                id="reader-quote"
                label="摘录（可编辑）"
                value={quoteOverride}
                onChange={(event) => setQuoteOverride(event.target.value)}
                multiline
                minRows={4}
                fullWidth
                sx={{ mb: space.md, '& .MuiOutlinedInput-root': { bgcolor: 'var(--dr-color-surface-composer)' } }}
              />
              {context.selection && quoteOverride.trim() !== context.selection.quote.trim() && (
                <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: -space.sm, mb: space.md }}>
                  摘录已编辑；保存后不附带精确原文锚点。
                </Typography>
              )}
              <TextField
                id="reader-note"
                label="我的笔记"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="补充你的判断、疑问或适用条件…"
                multiline
                minRows={4}
                fullWidth
                sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'var(--dr-color-surface-composer)' } }}
              />
              <Stack direction="row" spacing={space.md} sx={{ mt: space.md, alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="caption" color="text.secondary" sx={{ minWidth: 0 }}>
                  只保存你确认的摘录、笔记和 AI 结论；不会自动保存整篇网页。
                </Typography>
                <Button
                  variant="contained"
                  disabled={Boolean(busy) || Boolean(saved)}
                  startIcon={saved ? <Check size={14} /> : <Bookmark size={14} />}
                  onClick={() => void saveResult()}
                  sx={{ flexShrink: 0 }}
                >
                  {saved ? '已保存草稿' : '保存到研究库'}
                </Button>
              </Stack>
            </Paper>
          </>
        )}
      </Box>
      <style>{`
        html.reader-embedded header { display: none; }
        html.reader-embedded main { padding: 0 !important; }
      `}</style>
    </Box>
  );
}

/**
 * A secondary reading action. It carries the same outline treatment as the
 * shared button skin so the panel never grows a second control style.
 */
function ReaderAction({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <Button
      size="small"
      variant="outlined"
      color="secondary"
      disabled={disabled}
      onClick={onClick}
      startIcon={null}
      sx={{ gap: space.xs }}
    >
      {children}
    </Button>
  );
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return '当前网页';
  }
}

function sourceScopeNotice(value: string): string | null {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
      return 'GitHub 回答只基于当前展示的 README、文档或代码页面，不代表已读完整个仓库。';
    }
    if (hostname === 'zread.ai' || hostname.endsWith('.zread.ai')) {
      return 'Zread 回答只基于当前打开的小节，不代表已读完整个项目 Wiki。';
    }
  } catch {
    return null;
  }
  return null;
}

function makeSaveKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}
