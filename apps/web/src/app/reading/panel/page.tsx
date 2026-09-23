'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Bookmark, Check, Languages, Loader2, MessageCircle, Send, Sparkles, X } from 'lucide-react';

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

const panelMessage = (payload: unknown) => window.parent.postMessage(payload, '*');

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
    <div className="min-h-[calc(100dvh-8rem)] bg-[#f7f8f4] text-[#20211f]">
      <div className="mx-auto w-full max-w-2xl px-4 py-5 sm:px-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#315fe8]"><BookOpen className="h-3.5 w-3.5" /> Deep Research Reader</div>
            <h1 className="text-lg font-semibold leading-snug">{title}</h1>
            {context && <p className="mt-1 truncate text-xs text-[#5e625d]">{safeHostname(context.url)} · {scopeLabel}</p>}
          </div>
          <div className="flex items-center gap-1">
            {tokenPresent && <button aria-label="断开并撤销阅读令牌" disabled={disconnecting} className="rounded-md px-2 py-1 text-[11px] text-[#5e625d] hover:bg-white disabled:opacity-50" onClick={() => void disconnectReader()}>{disconnecting ? '断开中…' : '断开账号'}</button>}
            <button aria-label="关闭侧栏" className="rounded-md p-2 text-[#5e625d] hover:bg-white" onClick={() => panelMessage({ type: 'deep-research:close' })}><X className="h-4 w-4" /></button>
          </div>
        </div>

        {!context ? (
          <div className="rounded-xl border border-[#d9ddd5] bg-white p-6 text-sm text-[#5e625d] shadow-sm">
            <Sparkles className="mb-3 h-5 w-5 text-[#315fe8]" />
            点击浏览器工具栏的 Deep Research，再在网页中选择一段文字。插件只会在你发起操作时读取当前页面。
            <button className="mt-4 block rounded-lg bg-[#315fe8] px-3 py-2 text-xs font-medium text-white" onClick={() => panelMessage({ type: 'deep-research:connect' })}>连接 Deep Research 账号</button>
          </div>
        ) : (
          <>
            <section className="rounded-xl border border-[#d9ddd5] bg-white p-4 shadow-sm">
              <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-[#5e625d]"><span>原文摘录</span><span>{context.selection ? '已锚定' : '页面上下文'}</span></div>
              <blockquote className="border-l-2 border-[#315fe8] pl-3 text-sm leading-6 text-[#30332f]">{displayQuote}</blockquote>
              {context.translationDetected && <p role="status" className="mt-3 rounded-md bg-[#fff5e8] px-3 py-2 text-[11px] leading-5 text-[#8b5b20]">检测到页面已有其他翻译插件内容。为避免重复翻译，已暂停本插件的双语插入；请选择一个翻译器继续。</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="reader-action" disabled={Boolean(busy) || Boolean(context.translationDetected)} onClick={translateVisibleBlocks}><Languages className="h-3.5 w-3.5" /> {bilingualEnabled ? '继续翻译视口' : '开启双语'}</button>
                {bilingualEnabled && <button className="reader-action" disabled={Boolean(busy)} onClick={() => setBilingualPaused((paused) => !paused)}><Languages className="h-3.5 w-3.5" /> {bilingualPaused ? '继续处理' : '暂停双语'}</button>}
                <button className="reader-action" disabled={Boolean(busy)} onClick={() => panelMessage({ type: 'deep-research:restore-translations' })}><X className="h-3.5 w-3.5" /> 恢复原文</button>
                <button className="reader-action" disabled={Boolean(busy)} onClick={() => callAnswer('explain')}><Sparkles className="h-3.5 w-3.5" /> 解读</button>
                <button className="reader-action" disabled={Boolean(busy)} onClick={() => document.getElementById('reader-prompt')?.focus()}><MessageCircle className="h-3.5 w-3.5" /> 追问</button>
              </div>
              {translationFailures.length > 0 && <div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-[#fff5e8] px-3 py-2 text-xs text-[#8b5b20]"><span>{translationFailures.length} 段翻译失败</span><button className="font-medium underline" onClick={() => { const failedIds = [...translationFailures]; setBilingualPaused(true); setTranslatedBlockIds((previous) => { const next = new Set(previous); failedIds.forEach((id) => next.delete(id)); return next; }); void translatePage(failedIds, translationSelectionOnly).finally(() => setBilingualPaused(false)); }}>重试失败段落</button></div>}
            </section>

            <section className="mt-4 rounded-xl border border-[#d9ddd5] bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-2"><div className="flex items-center gap-2 text-sm font-semibold"><MessageCircle className="h-4 w-4 text-[#315fe8]" /> 围绕原文讨论</div>{context.selection && <div className="flex rounded-md border border-[#d9ddd5] p-0.5 text-[11px]" role="group" aria-label="讨论范围"><button className={`rounded px-2 py-1 ${discussionScope === 'selection' ? 'bg-[#eff4ff] text-[#315fe8]' : 'text-[#5e625d]'}`} onClick={() => setDiscussionScope('selection')}>当前选段</button><button className={`rounded px-2 py-1 ${discussionScope === 'page' ? 'bg-[#eff4ff] text-[#315fe8]' : 'text-[#5e625d]'}`} onClick={() => setDiscussionScope('page')}>问整页</button></div>}</div>
              <p className="mb-3 text-[11px] leading-5 text-[#767d75]">本轮范围：{discussionScope === 'page' || !context.selection ? '当前页面（已提取正文）' : '当前选段 + 所在小节'} · 回答会把原文证据与一般背景分开说明</p>
              {sourceNotice && <p className="mb-3 rounded-md bg-[#f5f6f2] px-3 py-2 text-[11px] leading-5 text-[#5e625d]">{sourceNotice}</p>}
              {anchorNotice && <p role="status" className="mb-3 rounded-md bg-[#fff5e8] px-3 py-2 text-xs text-[#8b5b20]">{anchorNotice}</p>}
              {answer && <div className="mb-4 whitespace-pre-wrap rounded-lg bg-[#eff4ff] p-3 text-sm leading-6"><div>{answer}</div>{context.selection && <button className="mt-3 text-xs font-medium text-[#315fe8] underline" onClick={() => panelMessage({ type: 'deep-research:focus-anchor', anchor: context.selection })}>回到原文证据</button>}</div>}
              {readingAnswer && (readingAnswer.evidence?.length || readingAnswer.background || readingAnswer.inference || readingAnswer.limitations?.length || readingAnswer.warnings?.length) ? (
                <div className="mb-4 space-y-3 text-xs leading-5">
                  {readingAnswer.evidence?.length ? <div><div className="mb-1 font-semibold text-[#20211f]">原文证据</div><div className="space-y-1.5">{readingAnswer.evidence.map((item, index) => <button key={`${item.quote}-${index}`} className="block w-full rounded-md border border-[#d9e0f1] bg-[#f7f9ff] px-3 py-2 text-left hover:border-[#9fb2ed]" onClick={() => item.anchor && panelMessage({ type: 'deep-research:focus-anchor', anchor: item.anchor })}><span className="block font-serif text-[#20211f]">“{item.quote}”</span>{item.claim && <span className="mt-1 block text-[#767d75]">{item.claim}</span>}</button>)}</div></div> : null}
                  {readingAnswer.background ? <div className="border-t border-[#d9ddd5] pt-2"><div className="font-semibold text-[#20211f]">必要背景</div><p className="mt-1 whitespace-pre-wrap">{readingAnswer.background}</p></div> : null}
                  {readingAnswer.inference ? <div className="border-t border-[#d9ddd5] pt-2"><div className="font-semibold text-[#20211f]">AI 推断</div><p className="mt-1 whitespace-pre-wrap">{readingAnswer.inference}</p></div> : null}
                  {readingAnswer.limitations?.length ? <div className="border-t border-[#d9ddd5] pt-2"><div className="font-semibold text-[#20211f]">适用条件与未知项</div><ul className="mt-1 list-disc pl-4">{readingAnswer.limitations.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div> : null}
                  {readingAnswer.warnings?.length ? <div className="rounded-md bg-[#fff5e8] px-3 py-2 text-[#8b5b20]">{readingAnswer.warnings.join('；')}</div> : null}
                </div>
              ) : null}
              <div className="flex gap-2">
                <input id="reader-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && canAsk) void callAnswer('ask'); }} placeholder="例如：这对系统设计有什么影响？" className="min-w-0 flex-1 rounded-lg border border-[#d9ddd5] px-3 py-2 text-sm outline-none focus:border-[#315fe8] focus:ring-2 focus:ring-[#eaf0ff]" />
                <button aria-label="发送问题" disabled={!canAsk} onClick={() => void callAnswer('ask')} className="rounded-lg bg-[#315fe8] px-3 text-white disabled:cursor-not-allowed disabled:opacity-40"><Send className="h-4 w-4" /></button>
              </div>
              {busy && <div className="mt-3 flex items-center gap-2 text-xs text-[#5e625d]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在处理当前{busy === 'translate' ? '页面翻译' : busy === 'explain' ? 'AI 解读' : '问题'}…<button className="ml-auto underline" onClick={() => activeRequest.current?.abort()}>停止</button></div>}
              {error && <div role="alert" className="mt-3 flex items-center justify-between gap-3 text-xs text-[#9d4638]"><span>{error}</span><button className="shrink-0 underline" onClick={() => panelMessage({ type: 'deep-research:connect' })}>连接账号</button></div>}
            </section>

            <section className="mt-4 rounded-xl border border-[#d9ddd5] bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Bookmark className="h-4 w-4 text-[#315fe8]" /> 保存阅读成果</div>
              <label className="mb-2 block text-[11px] font-medium text-[#5e625d]" htmlFor="reader-quote">摘录（可编辑）</label>
              <textarea id="reader-quote" value={quoteOverride} onChange={(event) => setQuoteOverride(event.target.value)} className="mb-3 min-h-20 w-full resize-y rounded-lg border border-[#d9ddd5] px-3 py-2 text-sm leading-6 outline-none focus:border-[#315fe8] focus:ring-2 focus:ring-[#eaf0ff]" />
              {context.selection && quoteOverride.trim() !== context.selection.quote.trim() && <p className="-mt-1 mb-3 text-[11px] leading-5 text-[#8b5b20]">摘录已编辑；保存后不附带精确原文锚点。</p>}
              <label className="mb-2 block text-[11px] font-medium text-[#5e625d]" htmlFor="reader-note">我的笔记</label>
              <textarea id="reader-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="补充你的判断、疑问或适用条件…" className="min-h-20 w-full resize-y rounded-lg border border-[#d9ddd5] px-3 py-2 text-sm outline-none focus:border-[#315fe8] focus:ring-2 focus:ring-[#eaf0ff]" />
              <div className="mt-3 flex items-center justify-between gap-3"><p className="text-[11px] leading-5 text-[#767d75]">只保存你确认的摘录、笔记和 AI 结论；不会自动保存整篇网页。</p><button onClick={() => void saveResult()} disabled={Boolean(busy) || Boolean(saved)} className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[#20211f] px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{saved ? <Check className="h-3.5 w-3.5" /> : <Bookmark className="h-3.5 w-3.5" />} {saved ? '已保存草稿' : '保存到研究库'}</button></div>
            </section>
          </>
        )}
      </div>
      <style>{`.reader-action{display:inline-flex;align-items:center;gap:.4rem;border:1px solid #d9ddd5;border-radius:.5rem;padding:.45rem .65rem;font-size:.75rem;font-weight:500;color:#30332f;background:#fff}.reader-action:hover{border-color:#315fe8;color:#315fe8}.reader-action:disabled{opacity:.45;cursor:not-allowed}html.reader-embedded header{display:none}html.reader-embedded main{padding:0!important}`}</style>
    </div>
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
