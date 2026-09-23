import { readerStore } from './reader-store.js';
import {
  explainSelection,
  explainImage,
  boundTaskContext,
  buildAnnotationUrl,
  loadProvider,
  makeDocument,
  mergeProcessedIds,
  mergeTranslationFailures,
  PROVIDER_PRESETS,
  providerReady,
  requestChat,
  saveProvider,
  testVisionProvider,
  translateBlocks,
  translateImage,
} from './reader-core.js';
import { renderMarkdown } from './markdown-renderer.js';

const $ = (id) => document.getElementById(id);
let provider = null;
let pageContext = null;
let documentContext = null;
let selectionContext = null;
let imageContext = null;
let latestAnswer = '';
let latestStructuredAnswer = null;
let discussionHistory = [];
let discussionScope = 'page';
let discussionIntent = 'ask';
let discussionOpen = false;
let pendingPageAction = null;
let discussionController = null;
let discussionRunning = false;
let translationController = null;
let translationRequested = false;
let fullTranslationEnabled = false;
let translationPaused = false;
let translationRunning = false;
let cancellationRequested = false;
let activeTranslationRun = 0;
let activeJobRecord = null;
let pendingJob = null;
let failedTranslationItems = [];
let retryingTranslationId = null;
let platformUrl = 'http://localhost:3000';
let platformConnected = false;
let readingMode = 'local';
let sessionSyncTimer = 0;
let radarEntryPlatformUrl = '';
let radarEntryPromptKey = '';
let radarEntrySummaryId = '';
// `init()` loads the persisted token asynchronously.  A callback can finish
// the PKCE exchange during that window; an older `loadPlatformState()` result
// must not overwrite the newer connection event and hide the sync controls.
let platformStateEvents = 0;
let targetLanguage = 'zh-CN';
let activeTabId = null;
let activationNeeded = null;
let pageReadState = 'idle';
let lastSavedInsight = null;
let editingInsight = null;
let pendingInsightSource = null;
let editingAnnotation = null;
let activeSessionTitle = '';
let sessionSaveQueue = Promise.resolve();
const translatedTextIds = new Set();
const translatedImageIds = new Set();
const resumedUrls = new Set();
const sessionResumeTasks = new Map();
let sessionGeneration = 0;
let interactionGeneration = 0;
const DISCUSSION_INTENTS = new Set(['explain', 'ask', 'summary', 'selection-summary', 'translate', 'map', 'architecture', 'tradeoffs']);

function sendToPage(payload) {
  chrome.runtime.sendMessage({ type: 'deep-research:to-page', payload }).catch(() => {});
}

function show(el, visible = true) { if (el) el.classList.toggle('hidden', !visible); }

function setNotice(message = '', target = $('notice')) {
  target.textContent = message;
  show(target, Boolean(message));
}

function setStatus(ready, text) {
  $('status-dot').classList.toggle('ready', ready);
  $('status-text').textContent = text;
}

function contextHasReadableBody(context) {
  if (!context) return false;
  const body = String(context.body || '').trim();
  const chars = Number(context.bodyCharCount || body.length || 0);
  const blocks = Number(context.blockCount || context.blocks?.length || 0);
  return Boolean(body && chars > 0 && blocks > 0);
}

function pageReadDescriptor(context = pageContext || documentContext) {
  if (activationNeeded?.reason === 'unsupported') {
    return { state: 'error', label: '当前页面不支持', detail: 'Chrome 保护页、扩展商店等页面不能注入阅读助手。' };
  }
  if (activationNeeded?.reason === 'permission') {
    return { state: 'idle', label: '尚未启用此站点', detail: '点击“启用此站点”后，Reader 才会读取正文。' };
  }
  if (!context) {
    return { state: pageReadState === 'error' ? 'error' : 'loading', label: '正在读取正文', detail: '正在提取标题、章节和可用正文。' };
  }
  if (!contextHasReadableBody(context)) {
    return { state: 'error', label: '没有可用正文', detail: '没有提取到可用于问答的正文；可以重新加载页面或选择一段原文。' };
  }
  const blocks = Number(context.blockCount || context.blocks?.length || 0);
  const chars = Number(context.bodyCharCount || String(context.body || '').length || 0);
  const bounded = context.bodyTruncated || context.blocksTruncated;
  const details = [`${blocks} 个正文块`, `${chars.toLocaleString()} 字符`];
  if (bounded) details.push('已按上下文上限截取');
  return { state: 'ready', label: '正文已读取', detail: details.join(' · ') };
}

function updatePageContextUi(context = pageContext || documentContext || selectionContext) {
  const descriptor = pageReadDescriptor(context);
  const status = $('page-context-status');
  const meta = $('page-context-meta');
  if (status) {
    status.textContent = descriptor.label;
    status.classList.toggle('is-ready', descriptor.state === 'ready');
    status.classList.toggle('is-error', descriptor.state === 'error');
    status.classList.toggle('is-loading', descriptor.state === 'loading' || descriptor.state === 'idle');
  }
  if (meta) meta.textContent = descriptor.detail;
  const scope = activeDiscussionScope();
  if ($('page-context-scope')) $('page-context-scope').textContent = discussionScopeLabel(scope);
  if ($('quick-actions-scope')) $('quick-actions-scope').textContent = discussionScopeLabel(scope);
  sendToPage({
    type: 'deep-research:reader-status',
    state: descriptor.state,
    label: descriptor.label,
    detail: descriptor.detail,
  });
}

function renderPersistentComposer(scope = activeDiscussionScope()) {
  const context = activeDiscussionContext(scope);
  const composer = $('persistent-composer');
  if (!composer) return;
  const visible = Boolean(pageContext || documentContext || selectionContext);
  show(composer, visible);
  const descriptor = pageReadDescriptor(context);
  const selectionReady = scope === 'selection' && Boolean(context?.selection?.quote);
  const pageReady = scope !== 'page' || contextHasReadableBody(context);
  const canSend = scope === 'page'
    ? contextHasReadableBody(context)
    : scope === 'selection'
      ? Boolean(pageReady && selectionReady)
      : Boolean(imageContext?.image && pageReady);
  if ($('composer-scope-label')) $('composer-scope-label').textContent = discussionScopeLabel(scope);
  if ($('composer-context-status')) $('composer-context-status').textContent = `正文状态：${descriptor.label}`;
  if ($('chat-composer-hint')) {
    $('chat-composer-hint').textContent = scope === 'selection'
      ? '只使用当前选段及所在小节'
      : scope === 'image'
        ? '结合当前图示和页面正文'
        : descriptor.detail;
  }
  const question = $('question-input');
  if (question) {
    question.placeholder = scope === 'selection'
      ? '只针对当前选段提问，例如：它为什么这样设计？'
      : scope === 'image'
        ? '针对当前图示提问，例如：这条数据流的瓶颈在哪里？'
        : '针对整篇文章提问，例如：作者的主要取舍是什么？';
  }
  const send = $('send-question');
  if (send) {
    send.disabled = !canSend || discussionRunning;
    send.title = canSend ? '使用上方显示的范围发送问题' : descriptor.detail;
  }
}

function platformModeReady() {
  return readingMode === 'platform' && platformConnected;
}

function updateReadingModeUi() {
  const platform = readingMode === 'platform';
  $('mode-local')?.setAttribute('aria-pressed', String(!platform));
  $('mode-platform')?.setAttribute('aria-pressed', String(platform));
  $('storage-status')?.classList.toggle('platform', platform);
  if ($('storage-status')) $('storage-status').textContent = platform ? '平台模式' : '独立模式';
  if ($('platform-inline-status')) {
    $('platform-inline-status').textContent = platform
      ? platformConnected ? '会话与结论同步到调研平台' : '平台模式尚未连接'
      : '成果保存在浏览器本地';
  }
  if ($('platform-inline-description')) {
    $('platform-inline-description').textContent = platform
      ? platformConnected
        ? '问答使用平台模型；正文、图片字节和翻译缓存仍只在浏览器处理。'
        : '到设置中连接平台，或切回独立模式继续使用本地模型。'
      : '连接调研平台后，可把会话和确认过的结论写入研究库。';
  }
  if (platformModeReady()) setStatus(true, '平台模型已连接');
  else setStatus(providerReady(provider), providerReady(provider) ? '本地模型已连接' : '未配置模型');
}

async function setReadingMode(mode) {
  readingMode = mode === 'platform' ? 'platform' : 'local';
  await readerStore.setSetting('readingMode', readingMode);
  updateReadingModeUi();
  renderEmptyState();
  if (readingMode === 'platform' && !platformConnected) showSettings();
}

function currentReadingLanguage() {
  return $('translation-language')?.value || targetLanguage || 'zh-CN';
}

function readingProvider() {
  return provider ? { ...provider, language: currentReadingLanguage() } : provider;
}

function providerPreset(kind) {
  return PROVIDER_PRESETS[kind] || PROVIDER_PRESETS.custom;
}

function streamAnswerPreview(value) {
  const text = String(value || '');
  const answerField = text.match(/"answer"\s*:\s*"((?:\\.|[^"\\])*)/u);
  if (answerField) {
    try { return JSON.parse(`"${answerField[1]}"`); } catch { return answerField[1].replace(/\\n/gu, '\n').replace(/\\"/gu, '"'); }
  }
  // A compatible provider may return ordinary prose despite the JSON request.
  // Avoid showing a half-written JSON envelope in that case.
  if (!/[{}[\]]/u.test(text)) return text.trim().slice(0, 4_000);
  return '';
}

function renderStructuredAnswer(result) {
  const structured = $('answer-structured');
  if (!structured) return;
  const answer = result && typeof result === 'object' ? result : null;
  const evidencePart = $('answer-evidence');
  const evidenceList = $('answer-evidence-list');
  const backgroundPart = $('answer-background');
  const inferencePart = $('answer-inference');
  const limitationsPart = $('answer-limitations');
  const warnings = $('answer-warnings');
  if (!answer) {
    show(structured, false);
    show($('answer-actions'), false);
    renderDiscussionFollowups();
    return;
  }
  renderMarkdown($('answer-output'), answer.answer || latestAnswer || '');
  evidenceList.textContent = '';
  (Array.isArray(answer.evidence) ? answer.evidence : []).forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'evidence-item';
    button.dataset.evidenceIndex = String(index);
    button.title = item.anchor?.quote ? '跳转到原文证据' : '这条证据没有可用的原文定位';
    const number = document.createElement('span');
    number.className = 'evidence-number';
    number.textContent = `[${index + 1}]`;
    const content = document.createElement('span');
    content.className = 'evidence-content';
    const quote = document.createElement('span');
    quote.className = 'evidence-quote';
    quote.textContent = `“${item.quote || ''}”`;
    content.appendChild(quote);
    if (item.claim) {
      const claim = document.createElement('span');
      claim.className = 'evidence-claim';
      claim.textContent = item.claim;
      content.appendChild(claim);
    }
    button.append(number, content);
    button.addEventListener('click', () => {
      if (item.anchor?.quote) {
        sendToPage({ type: 'deep-research:focus-anchor', anchor: item.anchor });
      } else {
        setNotice('这条证据没有可用的原文定位。');
      }
    });
    evidenceList.appendChild(button);
  });
  show(evidencePart, evidenceList.childElementCount > 0);
  $('answer-background-text').textContent = answer.background || '';
  show(backgroundPart, Boolean(answer.background));
  $('answer-inference-text').textContent = answer.inference || '';
  show(inferencePart, Boolean(answer.inference));
  const limitationList = $('answer-limitations-list');
  limitationList.textContent = '';
  (Array.isArray(answer.limitations) ? answer.limitations : []).forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item;
    limitationList.appendChild(li);
  });
  show(limitationsPart, limitationList.childElementCount > 0);
  const warningText = Array.isArray(answer.warnings) ? answer.warnings.filter(Boolean).join('\n') : '';
  warnings.textContent = warningText;
  show(warnings, Boolean(warningText));
  show(structured, Boolean(evidenceList.childElementCount || answer.background || answer.inference || limitationList.childElementCount || warningText));
  show($('answer-actions'), Boolean(answer.answer || latestAnswer));
  renderDiscussionFollowups();
}

function answerClipboardText() {
  const answer = latestStructuredAnswer && typeof latestStructuredAnswer === 'object'
    ? latestStructuredAnswer
    : { answer: latestAnswer };
  const lines = [String(answer.answer || latestAnswer || '').trim()];
  const evidence = Array.isArray(answer.evidence) ? answer.evidence : [];
  if (evidence.length) {
    lines.push('', '原文证据');
    evidence.forEach((item, index) => {
      const quote = String(item?.quote || '').trim();
      const claim = String(item?.claim || '').trim();
      if (quote) lines.push(`[${index + 1}] ${quote}${claim ? `：${claim}` : ''}`);
    });
  }
  if (answer.inference) lines.push('', `AI 推断：${answer.inference}`);
  return lines.join('\n').trim();
}

async function copyAnswer() {
  const text = answerClipboardText();
  if (!text) {
    setNotice('当前还没有可复制的回答。');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setNotice('回答和原文证据已复制。');
  } catch {
    setNotice('浏览器没有开放剪贴板权限，请手动选择回答复制。');
  }
}

function ensureSaveDialog() {
  let section = $('save-dialog');
  const bindActions = (dialog) => {
    if (!dialog || dialog.dataset.readerActionsBound === 'true') return dialog;
    dialog.dataset.readerActionsBound = 'true';
    dialog.querySelector('#confirm-save')?.addEventListener('click', () => void confirmSaveInsight());
    dialog.querySelector('#cancel-save')?.addEventListener('click', () => { editingInsight = null; pendingInsightSource = null; showReading(); });
    return dialog;
  };
  if (section) return bindActions(section);
  section = document.createElement('section');
  section.id = 'save-dialog';
  section.className = 'setting-panel hidden';
  section.innerHTML = `<div class="eyebrow">保存阅读成果</div><h2>留下以后能复用的结论</h2><p class="small" style="margin-top:8px">先确认摘录、笔记和 AI 结论，再保存到本地阅读库。原文不会自动全文保存。</p><div class="card paper"><div class="card-title"><span>原文摘录</span><span id="save-source-title">当前页面</span></div><textarea id="save-quote" class="input" style="margin-top:9px;min-height:100px"></textarea></div><div class="field"><label for="save-note">我的笔记</label><textarea id="save-note" placeholder="补充自己的判断、待验证问题或使用场景"></textarea></div><div class="field"><label for="save-ai-answer">要保存的 AI 结论</label><textarea id="save-ai-answer" placeholder="可以删掉不想长期保留的部分"></textarea></div><div class="field"><label for="save-tags">标签（用逗号分隔，最多 10 个）</label><input id="save-tags" class="input" placeholder="架构, 性能, 待验证" /></div><div id="save-notice" class="notice hidden"></div><div class="actions"><button id="confirm-save" class="primary">保存到本地阅读库</button><button id="cancel-save" class="secondary">取消</button></div>`;
  document.querySelector('main.shell')?.appendChild(section);
  return bindActions(section);
}

function ensureAnnotationDialog() {
  let section = $('annotation-dialog');
  const bindActions = (dialog) => {
    if (!dialog || dialog.dataset.readerActionsBound === 'true') return dialog;
    dialog.dataset.readerActionsBound = 'true';
    dialog.querySelector('#confirm-annotation')?.addEventListener('click', () => void confirmAnnotation());
    dialog.querySelector('#cancel-annotation')?.addEventListener('click', () => { editingAnnotation = null; showReading(); });
    return dialog;
  };
  if (section) return bindActions(section);
  section = document.createElement('section');
  section.id = 'annotation-dialog';
  section.className = 'setting-panel hidden';
  section.innerHTML = '<div class="eyebrow">原文标注</div><h2>给这段内容留下线索</h2><p class="small" style="margin-top:8px">标注只保存精确摘录、页面版本和你的短笔记，不保存全文。页面变化后会保留记录，但不会错误高亮。</p><div class="card paper"><div class="card-title"><span>原文摘录</span><span id="annotation-source-title">当前页面</span></div><textarea id="annotation-quote" class="input" style="margin-top:9px;min-height:100px" readonly></textarea></div><div class="field"><label for="annotation-note">标注笔记</label><textarea id="annotation-note" placeholder="例如：这里是性能瓶颈的关键假设"></textarea></div><div id="annotation-notice" class="notice hidden"></div><div class="actions"><button id="confirm-annotation" class="primary">保存标注</button><button id="cancel-annotation" class="secondary">取消</button></div>';
  document.querySelector('main.shell')?.appendChild(section);
  return bindActions(section);
}

function contextUrl() { return documentContext?.url || pageContext?.url || selectionContext?.url || ''; }

function normalizePlatformOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function normalizeRadarSummaryId(value) {
  const candidate = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate)
    ? candidate
    : '';
}

function applyRadarEntryContext(context) {
  if (context?.entrySource !== 'radar') {
    radarEntryPlatformUrl = '';
    radarEntryPromptKey = '';
    radarEntrySummaryId = '';
    return;
  }
  const hintedOrigin = normalizePlatformOrigin(context.entryPlatformUrl);
  const summaryId = normalizeRadarSummaryId(context.entrySummaryId);
  if (hintedOrigin) radarEntryPlatformUrl = hintedOrigin;
  if (summaryId) radarEntrySummaryId = summaryId;

  const configuredOrigin = normalizePlatformOrigin(platformUrl);
  const canPrefill = !configuredOrigin || configuredOrigin === 'http://localhost:3000';
  if (hintedOrigin && canPrefill) {
    platformUrl = hintedOrigin;
    if ($('platform-url')) $('platform-url').value = hintedOrigin;
  }

  const promptKey = `${summaryId}:${hintedOrigin}`;
  if (!promptKey || promptKey === ':') return;
  if (promptKey === radarEntryPromptKey || platformConnected) return;
  radarEntryPromptKey = promptKey;
  setNotice('这篇内容来自雷达。平台地址已预填；如需同步，请在设置中明确点击“连接平台”。');
}

function persistJobPatch(job, patch) {
  if (!job?.id) return;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  void readerStore.saveJob(job);
}

function saveLocalSession() {
  if (!contextUrl()) return;
  const pageVersion = documentContext?.contentHash || pageContext?.contentHash || selectionContext?.contentHash || null;
  const snapshot = {
    url: contextUrl(),
    title: activeSessionTitle || documentContext?.title || pageContext?.title || selectionContext?.title || '未命名页面',
    titleEdited: Boolean(activeSessionTitle && activeSessionTitle !== (documentContext?.title || pageContext?.title || selectionContext?.title || '')),
    version: pageVersion,
    stale: false,
    selection: selectionContext?.selection || null,
    answer: latestAnswer,
    answerStructured: latestStructuredAnswer,
    discussion: discussionHistory,
    discussionScope,
    discussionIntent,
    radarSummaryId: radarEntrySummaryId || null,
    image: imageContext?.image ? {
      id: imageContext.image.id,
      src: imageContext.image.src || '',
      alt: imageContext.image.alt || '',
      width: imageContext.image.width || 0,
      height: imageContext.image.height || 0,
    } : null,
    scrollY: pageContext?.scrollY || documentContext?.scrollY || 0,
    scrollHeight: pageContext?.scrollHeight || documentContext?.scrollHeight || 0,
    updatedAt: new Date().toISOString(),
  };
  // Page-context, selection, scroll and answer events can arrive close
  // together. Serialize writes so an earlier empty snapshot cannot finish
  // after a newer conversation snapshot and erase the visible history.
  sessionSaveQueue = sessionSaveQueue
    .then(() => readerStore.saveSession(snapshot))
    .catch(() => {});
  schedulePlatformSessionSync();
}

function schedulePlatformSessionSync() {
  if (!platformModeReady() || !contextUrl()) return;
  window.clearTimeout(sessionSyncTimer);
  sessionSyncTimer = window.setTimeout(() => {
    void syncCurrentSession({ quiet: true });
  }, 900);
}

async function resumeSession(context) {
  if (!context?.url || resumedUrls.has(context.url)) return;
  const running = sessionResumeTasks.get(context.url);
  if (running) return running;
  const generation = sessionGeneration;
  const interaction = interactionGeneration;
  const task = (async () => {
    const version = context.contentHash || context.version || null;
    if (version) await readerStore.markSessionsStale(context.url, version);
    const pending = await consumePendingSession(context, version);
    const session = pending || await readerStore.getSession(context.url, version);
    if (!session || generation !== sessionGeneration || interaction !== interactionGeneration) return;
    activeSessionTitle = session.titleEdited ? (session.title || context.title || '') : '';
    if (Number(session.scrollY) > 0 || session.selection?.quote || session.image?.id || session.answer || session.discussion?.length) {
      latestAnswer = session.answer || '';
      latestStructuredAnswer = session.answerStructured || null;
      discussionHistory = Array.isArray(session.discussion) ? session.discussion : [];
      discussionOpen = Boolean(
        session.answer
        || session.answerStructured
        || session.discussion?.length,
      );
      discussionIntent = DISCUSSION_INTENTS.has(session.discussionIntent)
        ? session.discussionIntent
        : session.discussion?.some((item) => item?.role === 'user') ? 'ask' : 'explain';
      if (session.selection?.quote) {
        selectionContext = { ...context, scope: 'selection', selection: session.selection };
      }
      discussionScope = ['selection', 'page', 'image'].includes(session.discussionScope)
        ? session.discussionScope
        : 'selection';
    if (session.image?.id) imageContext = { ...context, image: session.image, restored: true };
    const restoredRadarSummaryId = normalizeRadarSummaryId(session.radarSummaryId);
    if (restoredRadarSummaryId) radarEntrySummaryId = restoredRadarSummaryId;
    renderPage();
      sendToPage({ type: 'deep-research:restore-progress', scrollY: session.scrollY, anchor: session.selection || null });
      if (session.pendingEvidenceAnchor?.quote) {
        sendToPage({ type: 'deep-research:focus-anchor', anchor: session.pendingEvidenceAnchor });
      }
      setNotice(session.resumedFromHistory
        ? session.stale
          ? '已恢复历史会话；当前原文版本不同，旧证据请重新核对后再继续。'
          : '已恢复历史会话，可以继续提问。'
        : '已恢复上次阅读位置；选择原文后可以继续讨论。');
      if (session.resumedFromHistory) window.setTimeout(() => $('question-input')?.focus(), 0);
    }
  })();
  sessionResumeTasks.set(context.url, task);
  try {
    await task;
  } finally {
    if (sessionResumeTasks.get(context.url) === task) sessionResumeTasks.delete(context.url);
    if (generation === sessionGeneration) resumedUrls.add(context.url);
  }
}

async function consumePendingSession(context, currentVersion) {
  if (!chrome.storage.session?.get) return null;
  const stored = await chrome.storage.session.get('readerPendingSession').catch(() => ({}));
  const pending = stored?.readerPendingSession;
  if (!pending || readerStore.pageKey(pending.url) !== readerStore.pageKey(context.url)) return null;
  await chrome.storage.session.remove('readerPendingSession').catch(() => {});
  const stale = Boolean(pending.version && currentVersion && pending.version !== currentVersion);
  const { id: _id, remote: _remote, pendingEvidenceAnchor, ...rest } = pending;
  const restored = {
    ...rest,
    url: context.url,
    title: pending.title || context.title || '未命名页面',
    version: currentVersion || pending.version || null,
    stale,
    staleAgainstVersion: stale ? currentVersion : null,
    resumedFromHistory: true,
    ...(pendingEvidenceAnchor?.quote ? { pendingEvidenceAnchor } : {}),
    updatedAt: new Date().toISOString(),
  };
  await readerStore.saveSession(restored);
  return restored;
}

function formatCoverage(context, scope) {
  if (scope === 'selection') {
    const quoteLength = String(context?.selection?.quote || '').length;
    const section = context?.sectionTitle || '所在小节';
    return `当前选段 · ${quoteLength.toLocaleString()} 字符 · ${section}`;
  }
  if (scope === 'image') return '当前图示与页面正文';
  const blocks = Number(context?.blockCount || context?.blocks?.length || 0);
  const chars = Number(context?.bodyCharCount || String(context?.body || '').length || 0);
  const bounded = context?.bodyTruncated || context?.blocksTruncated;
  const parts = ['整页正文'];
  if (blocks) parts.push(`${blocks} 个正文块`);
  if (chars) parts.push(`${chars.toLocaleString()} 字符`);
  if (bounded) parts.push('已按上下文上限截取');
  return parts.join(' · ');
}

function discussionIntentLabel(intent = discussionIntent) {
  if (intent === 'summary') return '全文总结';
  if (intent === 'selection-summary') return '选段总结';
  if (intent === 'translate') return '翻译';
  if (intent === 'map') return '文章地图';
  if (intent === 'architecture') return '关键机制';
  if (intent === 'tradeoffs') return '风险与取舍';
  if (intent === 'ask') return '提问';
  return '解读';
}

function discussionScopeLabel(scope = discussionScope) {
  if (scope === 'page') return '整页正文';
  if (scope === 'image') return '当前图示';
  return '当前选段';
}

function discussionLabel(scope = discussionScope, intent = discussionIntent) {
  return `${discussionScopeLabel(scope)} · ${discussionIntentLabel(intent)}`;
}

function renderDiscussionScopeControls(scope = discussionScope) {
  const options = [
    ['scope-page', 'page'],
    ['scope-selection', 'selection'],
    ['scope-image', 'image'],
  ];
  options.forEach(([id, optionScope]) => {
    const button = $(id);
    if (!button) return;
    const available = optionScope === 'page'
      || optionScope === 'selection' && Boolean(selectionContext?.selection?.quote)
      || optionScope === 'image' && Boolean(imageContext?.image);
    show(button, available);
    button.setAttribute('aria-pressed', String(scope === optionScope));
    button.classList.toggle('active', scope === optionScope);
  });
  const hint = $('scope-control-hint');
  if (hint) {
    hint.textContent = scope === 'selection'
      ? '只使用选段及其所在小节'
      : scope === 'image'
        ? '结合图示和页面正文'
        : '会使用当前页面的正文';
  }
}

function activeDiscussionScope() {
  if (discussionScope === 'selection' && selectionContext?.selection?.quote) return 'selection';
  if (discussionScope === 'image' && imageContext?.image) return 'image';
  return 'page';
}

function activeDiscussionContext(scope = activeDiscussionScope()) {
  if (scope === 'selection') return selectionContext;
  if (scope === 'image') return imageContext || documentContext || pageContext;
  return documentContext || pageContext || selectionContext;
}

function renderDiscussionContext(scope = discussionScope, intent = discussionIntent, context = null) {
  const label = $('discussion-context');
  const detail = $('discussion-context-detail');
  const source = context || activeDiscussionContext(scope);
  if (label) label.textContent = discussionLabel(scope, intent);
  if ($('discussion-source-title')) $('discussion-source-title').textContent = source?.title || pageContext?.title || '当前页面';
  if ($('discussion-source-url')) $('discussion-source-url').textContent = source?.url || pageContext?.url || '';
  if ($('discussion-source-scope')) $('discussion-source-scope').textContent = discussionScopeLabel(scope);
  if (detail) {
    detail.textContent = formatCoverage(source, scope);
  }
  renderDiscussionScopeControls(scope);
  updatePageContextUi(source || pageContext || documentContext);
  renderPersistentComposer(scope);
  if ($('chat-composer-hint')) {
    $('chat-composer-hint').textContent = scope === 'selection'
      ? '只使用当前选段及所在小节'
      : scope === 'image'
        ? '结合当前图示和页面正文'
        : '使用整页正文回答';
  }
}

function suggestedFollowups(scope = activeDiscussionScope(), intent = discussionIntent) {
  if (scope === 'selection') {
    if (intent === 'translate') return ['这段中的技术术语分别是什么意思？', '把这段改写成实现步骤。', '这段内容有哪些隐含前提？'];
    if (intent === 'selection-summary') return ['这段结论依赖哪些原文证据？', '这段和文章主线是什么关系？', '这段有没有可能的反例？'];
    return ['这段代码或机制的关键约束是什么？', '能用一个具体例子说明吗？', '这段方案的替代做法是什么？'];
  }
  if (scope === 'image') return ['图中的数据流瓶颈在哪里？', '哪些组件关系可以从图中直接确认？', '这张图对应的实现风险是什么？'];
  if (intent === 'summary') return ['作者的核心假设是什么？', '哪些结论需要结合其他资料核对？', '这套方案与常见做法相比改变了什么？'];
  if (intent === 'map') return ['先解释最关键的一条依赖链。', '哪一章最值得优先阅读？', '文章的主线是否存在跳步？'];
  if (intent === 'architecture') return ['哪些组件是不可替代的？', '如果规模扩大，最先遇到什么瓶颈？', '请把架构转成实现检查清单。'];
  if (intent === 'tradeoffs') return ['哪些取舍是文章明确说出的？', '有哪些失败条件没有被验证？', '请给出一个反例或替代方案。'];
  return ['用一个具体例子说明刚才的结论。', '这篇文章有哪些隐含前提？', '请把回答压缩成实现检查清单。'];
}

function renderDiscussionFollowups(scope = activeDiscussionScope(), intent = discussionIntent) {
  const section = $('discussion-followups');
  const list = $('discussion-followup-list');
  if (!section || !list) return;
  list.textContent = '';
  if (!latestStructuredAnswer || discussionRunning) {
    show(section, false);
    return;
  }
  suggestedFollowups(scope, intent).forEach((prompt) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'discussion-followup';
    button.textContent = prompt;
    button.title = '继续使用当前上下文提问';
    button.addEventListener('click', () => {
      if (discussionRunning) return;
      void explainOrAsk(prompt, scope, 'ask');
    });
    list.appendChild(button);
  });
  show(section, list.childElementCount > 0);
}

function renderConversation() {
  const list = $('conversation-list');
  if (!list) return;
  list.textContent = '';
  const messages = discussionHistory.filter((item) => item && ['user', 'assistant'].includes(item.role) && String(item.content || '').trim());
  messages.forEach((item) => {
    const message = document.createElement('article');
    message.className = `conversation-message ${item.role === 'user' ? 'user' : 'assistant'}`;
    const header = document.createElement('div');
    header.className = 'conversation-message-header';
    header.textContent = item.role === 'user' ? '你' : 'Reader';
    const body = document.createElement('div');
    body.className = 'conversation-message-body';
    if (item.role === 'assistant') renderMarkdown(body, String(item.content || ''));
    else body.textContent = String(item.content || '');
    message.append(header, body);
    list.appendChild(message);
  });
  show(list, messages.length > 0);
  show($('conversation-empty'), messages.length === 0 && !discussionRunning);
}

function renderEmptyState() {
  const title = $('empty-title');
  const description = $('empty-description');
  const primary = $('empty-settings');
  if (!title || !description || !primary) return;
  if (!providerReady(provider) && !platformModeReady()) {
    title.textContent = '先连接一个模型，再开始阅读。';
    description.textContent = readingMode === 'platform'
      ? '连接调研平台后使用平台模型，或切回独立模式配置自己的模型。'
      : '模型配置只保存在本地。配置完成后，点击扩展按钮启用当前网页。';
    primary.textContent = readingMode === 'platform' ? '连接平台' : '配置模型';
    primary.disabled = false;
    show(primary, true);
    return;
  }
  if (activationNeeded?.reason === 'unsupported') {
    title.textContent = '当前页面不支持阅读。';
    description.textContent = 'Chrome 内置页、扩展商店和其他受保护页面不允许注入阅读助手。请切换到公开文章、文档或 GitHub 页面。';
    show(primary, false);
    return;
  }
  if (activationNeeded?.reason === 'unknown') {
    title.textContent = '暂时无法确认当前网页。';
    description.textContent = '请切回普通网页，或点击浏览器工具栏中的 Deep Research Reader 图标后重试。';
    primary.textContent = '重新检查当前页';
    primary.disabled = false;
    show(primary, true);
    return;
  }
  if (activationNeeded?.reason === 'permission') {
    title.textContent = '启用当前网页，开始阅读。';
    description.textContent = '只会为这个站点申请访问权限。点击后才读取当前页面，之后在本窗口切换网页会再次询问。';
    primary.textContent = '启用此站点';
    primary.disabled = false;
    show(primary, true);
    return;
  }
  title.textContent = '开始阅读当前网页。';
  description.textContent = '点击下方按钮只启用当前页；全文翻译、选段解读和讨论都从原网页开始。';
  primary.textContent = '开始阅读当前页';
  primary.disabled = false;
  show(primary, true);
}

function renderSavedInsightBanner() {
  const banner = $('saved-insight-banner');
  if (!banner) return;
  const currentUrl = contextUrl();
  const visible = Boolean(lastSavedInsight?.id && lastSavedInsight.url && lastSavedInsight.url === currentUrl);
  show(banner, visible);
  if (!visible) return;
  if ($('saved-insight-title')) $('saved-insight-title').textContent = '已保存阅读结论';
  if ($('saved-insight-detail')) {
    $('saved-insight-detail').textContent = lastSavedInsight.quote
      ? `已保存摘录和结论：${String(lastSavedInsight.quote).slice(0, 72)}${String(lastSavedInsight.quote).length > 72 ? '…' : ''}`
      : '可以回到当前会话继续讨论。';
  }
}

function latestAnswerSource() {
  const context = activeDiscussionContext(activeDiscussionScope()) || documentContext || pageContext || selectionContext;
  if (!context?.url) return null;
  const answer = latestStructuredAnswer && typeof latestStructuredAnswer === 'object'
    ? latestStructuredAnswer
    : null;
  const evidence = Array.isArray(answer?.evidence)
    ? answer.evidence.find((item) => item?.quote && item?.anchor?.quote)
    : null;
  if (evidence) {
    const version = context.contentHash || context.version || evidence.anchor.contentHash || null;
    return {
      title: context.title || '未命名页面',
      url: context.url,
      document: { url: context.url, title: context.title || '未命名页面', version },
      quote: String(evidence.quote).trim(),
      anchor: evidence.anchor,
      note: '',
      aiAnswer: latestAnswer,
      tags: [],
    };
  }
  if (selectionContext?.selection?.quote && selectionContext.url === context.url) {
    const version = selectionContext.contentHash || selectionContext.version || selectionContext.selection.contentHash || null;
    return {
      title: selectionContext.title || context.title || '未命名页面',
      url: selectionContext.url,
      document: { url: selectionContext.url, title: selectionContext.title || context.title || '未命名页面', version },
      quote: selectionContext.selection.quote,
      anchor: selectionContext.selection,
      note: '',
      aiAnswer: latestAnswer,
      tags: [],
    };
  }
  const body = String(context.body || '').trim();
  if (!body) return null;
  return {
    title: context.title || '未命名页面',
    url: context.url,
    document: { url: context.url, title: context.title || '未命名页面', version: context.contentHash || context.version || null },
    quote: body.slice(0, 600),
    note: '',
    aiAnswer: latestAnswer,
    tags: [],
    fallbackWarning: '当前回答没有可精确定位的原文证据；这里只能保存页面开头的无锚点摘录，请确认后再保存。',
  };
}

function returnLatestAnswerToSource() {
  const source = latestAnswerSource();
  if (!source) {
    setNotice('当前回答没有可回链的原文证据。');
    return;
  }
  if (!source.anchor?.quote) {
    setNotice('当前回答没有可精确定位的证据，无法安全跳回原文。');
    return;
  }
  sendToPage({ type: 'deep-research:focus-anchor', anchor: source.anchor });
}

function renderPage() {
  const context = pageContext || documentContext || selectionContext;
  show($('empty-view'), !context);
  show($('page-view'), Boolean(context));
  if (!context) {
    show($('persistent-composer'), false);
    renderEmptyState();
    return;
  }
  $('page-title').textContent = context.title || '未命名页面';
  $('page-source').textContent = context.url || '';
  updatePageContextUi(context);
  const scopeNotice = $('scope-notice');
  const scopeWarnings = Array.isArray(context.scopeWarnings) ? context.scopeWarnings.filter(Boolean) : [];
  if (context.entrySource === 'radar') {
    scopeWarnings.unshift('来自 Deep Research 雷达。平台地址已预填，连接和同步仍需你的明确操作。');
  }
  if (scopeNotice) {
    scopeNotice.textContent = scopeWarnings.join('\n');
    show(scopeNotice, scopeWarnings.length > 0);
  }
  if (context.translationDetected && !translationRequested) {
    setNotice('检测到页面可能已有其他翻译插件。开启 Deep Research Reader 前请确认是否继续，避免重复插入译文。');
  }
  show($('selection-section'), Boolean(selectionContext?.selection?.quote));
  if (selectionContext?.selection?.quote) {
    $('selection-quote').textContent = selectionContext.selection.quote;
    $('selection-scope').textContent = selectionContext.sectionTitle || '所在小节';
  }
  show($('image-section'), Boolean(imageContext?.image));
  if (imageContext?.image) {
    const image = imageContext.image;
    $('image-preview-title').textContent = image.alt || image.src || `图示 ${image.id || ''}`;
    $('image-preview-meta').textContent = imageContext.restored
      ? '已恢复图示讨论上下文；如需继续追问，请在原网页重新点击该图示。'
      : `${image.width || '?'} × ${image.height || '?'} · 图片内容只按需发送给视觉模型`;
  }
  const visibleDiscussionScope = activeDiscussionScope();
  // Keep the page action surface compact until the user chooses a discussion
  // action. Once opened, the same section becomes a persistent transcript and
  // composer, so the user can continue the conversation without losing scope.
  const discussionVisible = Boolean(
    discussionOpen
    || discussionHistory.length
    || latestAnswer
    || latestStructuredAnswer,
  );
  show($('discussion-section'), discussionVisible);
  renderDiscussionContext(visibleDiscussionScope, discussionIntent, activeDiscussionContext(visibleDiscussionScope));
  renderConversation();
  renderMarkdown($('answer-output'), latestAnswer);
  show($('answer-output'), discussionOpen && (discussionRunning || !discussionHistory.length));
  renderStructuredAnswer(latestStructuredAnswer);
  renderDiscussionFollowups(visibleDiscussionScope, discussionIntent);
  renderPersistentComposer(visibleDiscussionScope);
  renderSavedInsightBanner();
}

function renderProgress(textDone = 0, textTotal = 0, imageDone = 0, imageTotal = 0) {
  show($('progress-area'), Boolean(textTotal || imageTotal || translationRunning || failedTranslationItems.length));
  $('text-progress-value').textContent = `${textDone} / ${textTotal}`;
  $('text-progress-bar').style.width = `${textTotal ? Math.round((textDone / textTotal) * 100) : 0}%`;
  $('image-progress-value').textContent = imageTotal ? `${imageDone} / ${imageTotal}` : '无可读取图片';
  $('image-progress-bar').style.width = `${imageTotal ? Math.round((imageDone / imageTotal) * 100) : 0}%`;
  $('translate-all').textContent = translationRunning ? '处理中…' : '全文翻译';
  $('translate-all').disabled = translationRunning;
  show($('pause-translation'), translationRunning);
  show($('cancel-translation'), translationRunning);
  renderTranslationFailures();
}

function renderTranslationFailures() {
  const section = $('translation-failures');
  if (!section) return;
  section.textContent = '';
  if (!failedTranslationItems.length) {
    show(section, false);
    return;
  }
  const title = document.createElement('div');
  title.className = 'translation-failures-title';
  title.textContent = `${failedTranslationItems.length} 项需要处理`;
  section.appendChild(title);
  failedTranslationItems.slice(0, 20).forEach((item) => {
    const row = document.createElement('div');
    row.className = 'translation-failure-row';
    const copy = document.createElement('div');
    copy.className = 'translation-failure-label';
    copy.textContent = `${item.kind === 'image' ? '图片' : '正文'} · ${item.label || item.id}`;
    copy.title = item.error || '';
    const error = document.createElement('div');
    error.className = 'translation-failure-error';
    error.textContent = item.error || '处理失败';
    copy.appendChild(error);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'translation-retry';
    button.textContent = retryingTranslationId === item.id ? '处理中…' : '重试';
    button.disabled = Boolean(retryingTranslationId);
    button.addEventListener('click', () => void retryTranslationItem(item));
    row.append(copy);
    if (item.kind === 'image' && /动画图片只处理/u.test(item.error || '')) {
      const frameButton = document.createElement('button');
      frameButton.type = 'button';
      frameButton.className = 'translation-retry';
      frameButton.textContent = '标记当前帧';
      frameButton.disabled = Boolean(retryingTranslationId);
      frameButton.addEventListener('click', () => {
        sendToPage({ type: 'deep-research:mark-static-frame', imageId: item.id });
        setNotice('已标记当前帧；正在重新读取图片，随后可重试翻译。');
      });
      row.append(frameButton);
    }
    row.append(button);
    section.appendChild(row);
  });
  if (failedTranslationItems.length > 20) {
    const more = document.createElement('div');
    more.className = 'translation-failure-error';
    more.textContent = `还有 ${failedTranslationItems.length - 20} 项未展开。再次点击全文翻译可继续处理。`;
    section.appendChild(more);
  }
  show(section, true);
}

async function applyAnnotationsForContext(context) {
  if (!context?.url) {
    sendToPage({ type: 'deep-research:clear-annotations' });
    return;
  }
  const version = context.contentHash || context.version || null;
  const annotations = (await readerStore.listAnnotations()).filter((annotation) => {
    if (!annotation?.document?.url || readerStore.pageKey(annotation.document.url) !== readerStore.pageKey(context.url)) return false;
    const annotationVersion = annotation.document.version || null;
    // A versioned annotation is only drawn on the exact page snapshot it was
    // created against. An unversioned imported record remains local but is
    // deliberately not drawn because a similar quote is not evidence.
    return Boolean(version && annotationVersion && version === annotationVersion);
  });
  sendToPage({ type: 'deep-research:apply-annotations', annotations });
}

async function updateLibrary() {
  const [insights, sessions, annotations] = await Promise.all([
    readerStore.listInsights(),
    readerStore.listSessions(),
    readerStore.listAnnotations(),
  ]);
  const list = $('library-list');
  const historyButton = $('open-history');
  if (historyButton) historyButton.textContent = sessions.length ? `聊天记录 · ${sessions.length}` : '聊天记录';
  if (!insights.length && !sessions.length && !annotations.length) {
    list.textContent = '还没有本地保存的成果。';
    return;
  }
  list.textContent = '';
  insights.slice(0, 12).forEach((insight) => {
    const row = document.createElement('div');
    row.className = 'insight-row';
    // Imported titles, tags and IDs are untrusted data. Keep the markup
    // static and assign all user-controlled values through textContent.
    row.innerHTML = '<div class="row-main"><div class="row-title"></div><div class="row-meta"></div></div><div class="actions" style="margin-top:0"><button class="text-button" data-action="edit">编辑</button><button class="text-button" data-action="delete">删除</button></div>';
    row.querySelector('.row-title').textContent = insight.quote || insight.title;
    row.querySelector('.row-meta').textContent = `收藏${insight.tags?.length ? ` · ${insight.tags.join('、')}` : ''} · ${new Date(insight.createdAt).toLocaleString()}`;
    row.querySelector('[data-action="edit"]').addEventListener('click', () => openSaveDialog(insight));
    row.querySelector('[data-action="delete"]').addEventListener('click', async () => { await readerStore.deleteInsight(insight.id); updateLibrary(); });
    list.appendChild(row);
  });
  annotations.slice(0, 12).forEach((annotation) => {
    const row = document.createElement('div');
    row.className = 'insight-row annotation-row';
    row.innerHTML = '<div class="row-main"><div class="row-title"></div><div class="row-meta"></div></div><div class="actions" style="margin-top:0"><button class="text-button" data-action="focus">回到原文</button><button class="text-button" data-action="delete">删除</button></div>';
    row.querySelector('.row-title').textContent = annotation.note || annotation.anchor?.quote || annotation.document?.title || '未命名标注';
    row.querySelector('.row-meta').textContent = `标注 · ${annotation.anchor?.quote || ''} · ${new Date(annotation.updatedAt || annotation.createdAt).toLocaleString()}`;
    row.querySelector('[data-action="focus"]').addEventListener('click', async () => {
      try {
        await chrome.tabs.create({ url: buildAnnotationUrl(annotation.document.url, annotation.anchor), active: true });
      } catch {
        setNotice('无法打开原文，请复制来源地址后重试。');
      }
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      await readerStore.deleteAnnotation(annotation.id);
      if (readerStore.pageKey(contextUrl()) === readerStore.pageKey(annotation.document.url)) sendToPage({ type: 'deep-research:clear-annotations' });
      await updateLibrary();
    });
    list.appendChild(row);
  });
  sessions.slice(0, 6).forEach((session) => {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.innerHTML = '<div class="row-main"><div class="row-title"></div><div class="row-meta"></div></div><div class="actions" style="margin-top:0"><button class="text-button" data-action="open">打开原文</button><button class="text-button" data-action="delete">删除</button></div>';
    row.querySelector('.row-title').textContent = session.title || session.url;
    row.querySelector('.row-meta').textContent = `最近阅读 · ${new Date(session.updatedAt).toLocaleString()}`;
    row.querySelector('[data-action="open"]').addEventListener('click', async () => {
      try {
        await chrome.tabs.create({ url: session.url, active: true });
        setNotice('已打开原文；点击 Reader 后会恢复这页的本地阅读状态。');
      } catch {
        setNotice('无法打开原文，请复制来源地址后重试。');
      }
    });
    row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      await readerStore.deleteSession(session.url, session.version || null);
      setNotice('这条本地阅读会话已删除。');
      await updateLibrary();
    });
    list.appendChild(row);
  });
}

async function findPendingTranslation(context) {
  if (!context?.url || translationRunning || pendingJob?.documentUrl === context.url) return;
  const jobs = await readerStore.listJobs();
  const version = context.contentHash || context.version || null;
  const sameUrlJobs = jobs.filter((item) => item.documentUrl === context.url);
  // A URL is not a document identity. Keep old jobs visible in local storage,
  // but never resume one whose source hash is different (or missing). Mark it
  // stale so a later panel open cannot mistake it for recoverable work.
  const staleJobs = sameUrlJobs.filter((item) => version && item.status !== 'stale' && item.contentHash !== version);
  await Promise.all(staleJobs.map((item) => readerStore.saveJob({ ...item, status: 'stale', error: '页面内容已变化，旧翻译任务已失效', tabId: undefined })));
  if (staleJobs.length) setNotice('页面内容已变化，旧的翻译任务、证据和讨论已失效；请重新开始。');
  const job = sameUrlJobs.find((item) => item.contentHash && version && item.contentHash === version);
  if (!job || !['queued', 'running', 'cancelled', 'failed', 'completed', 'completed_with_errors'].includes(job.status)) return;
  pendingJob = job;
  activeJobRecord = job;
  failedTranslationItems = Array.isArray(job.failedItems) ? job.failedItems : [];
  renderProgress(job.textDone || 0, job.textTotal || 0, job.imageDone || 0, job.imageTotal || 0);
  setNotice(job.status === 'completed_with_errors'
    ? `上次全文翻译有 ${failedTranslationItems.length} 项未完成；可以逐项重试。`
    : `上次全文翻译停在 ${job.textDone || 0}/${job.textTotal || 0} 个正文块、${job.imageDone || 0}/${job.imageTotal || 0} 张图片；点击“全文翻译”可从本地缓存继续。`);
  // A side-panel document can be destroyed while a request is in flight. A
  // queued/running job is therefore a durable recovery signal. A completed
  // job is only history: translation results are a bounded cache, so opening
  // a page must never silently send fresh model requests after the cache has
  // been cleared. Completed-with-errors, cancelled, and failed jobs remain
  // explicit user retry actions.
  if (providerReady(provider) && ['queued', 'running'].includes(job.status)) {
    translationRequested = true;
    fullTranslationEnabled = true;
    translationPaused = false;
    translationRunning = true;
    activeTranslationRun += 1;
    translationController?.abort();
    translationController = new AbortController();
    pendingJob = null;
    setNotice('正在恢复上次未完成的全文翻译；已完成内容会从本地缓存跳过。');
    sendToPage({ type: 'deep-research:request-full-document' });
  }
}

function applyProviderFields() {
  const kind = provider?.providerKind || 'openai';
  if ($('provider-kind')) $('provider-kind').value = kind;
  if ($('provider-url')) $('provider-url').value = provider?.baseUrl || providerPreset(kind).baseUrl || '';
  if ($('provider-model')) $('provider-model').value = provider?.model || '';
  if ($('provider-key')) $('provider-key').value = provider?.apiKey || '';
  if ($('translation-language')) $('translation-language').value = targetLanguage || 'zh-CN';
  updateProviderForm();
  setStatus(providerReady(provider), providerReady(provider) ? `${provider.model} 已就绪` : '未配置模型');
}

function updateProviderForm() {
  const kind = $('provider-kind')?.value || 'openai';
  const preset = providerPreset(kind);
  const custom = kind === 'custom' || kind === 'custom-anthropic';
  show($('provider-custom-url-field'), custom);
  if (!custom && $('provider-url')) $('provider-url').value = preset.baseUrl;
  if ($('provider-model')) $('provider-model').placeholder = preset.placeholder;
  if ($('provider-endpoint-hint')) {
    $('provider-endpoint-hint').textContent = custom
      ? preset.protocol === 'anthropic'
        ? '自定义服务需要提供 Anthropic-compatible /messages 接口。'
        : '自定义服务需要提供 OpenAI-compatible /chat/completions 接口。'
      : preset.protocol === 'anthropic'
        ? '将使用 Anthropic Messages API：/messages。浏览器直连需要服务端允许扩展页面的 CORS 请求。'
        : `将使用 ${preset.label} 的 OpenAI-compatible /chat/completions 接口：${preset.baseUrl}`;
  }
}

async function loadTargetLanguage() {
  targetLanguage = await readerStore.getSetting('targetLanguage', 'zh-CN');
  if (!['zh-CN', 'zh-TW', 'ja-JP', 'en-US'].includes(targetLanguage)) targetLanguage = 'zh-CN';
  if ($('translation-language')) $('translation-language').value = targetLanguage;
}

async function requestOriginPermission(baseUrl) {
  if (!$('request-provider-origin').checked || !chrome.permissions?.request) return true;
  let origin;
  try { origin = `${new URL(baseUrl).origin}/*`; } catch { throw new Error('模型服务地址不是有效 URL'); }
  return chrome.permissions.request({ origins: [origin] });
}

async function requestSpecificOrigin(baseUrl) {
  if (!chrome.permissions?.request) return true;
  let origin;
  try { origin = `${new URL(baseUrl).origin}/*`; } catch { throw new Error('平台地址不是有效 URL'); }
  return chrome.permissions.request({ origins: [origin] });
}

function requestImageOrigins(images = []) {
  if (!chrome.permissions?.request) return Promise.resolve(true);
  const origins = [...new Set(images.map((image) => {
    try {
      const url = new URL(image.src || '');
      return /^https?:$/u.test(url.protocol) ? `${url.origin}/*` : '';
    } catch {
      return '';
    }
  }).filter(Boolean))].slice(0, 20);
  if (!origins.length) return Promise.resolve(true);
  return chrome.permissions.request({ origins });
}

function setPlatformConnected(connected, message = '') {
  platformConnected = connected;
  if (!$('platform-status')) return;
  show($('connect-platform'), !connected);
  show($('disconnect-platform'), connected);
  $('platform-status').textContent = message || (connected ? `已连接 · ${platformUrl}` : '未连接');
  $('platform-status').classList.toggle('connected', connected);
  show($('sync-selection'), connected && Boolean(lastSavedInsight));
  show($('sync-session'), connected && Boolean(contextUrl()));
  show($('restore-session'), connected);
  updateReadingModeUi();
  renderEmptyState();
}

async function loadPlatformState() {
  if (!$('platform-status')) return;
  const stateRead = platformStateEvents;
  const configuredUrl = normalizePlatformOrigin(await readerStore.getSetting('platformUrl', ''));
  platformUrl = configuredUrl || radarEntryPlatformUrl || 'http://localhost:3000';
  $('platform-url').value = platformUrl;
  const stored = await chrome.storage.local.get(['readerToken']);
  if (stateRead !== platformStateEvents) return;
  setPlatformConnected(Boolean(stored.readerToken));
}

async function connectPlatform() {
  platformUrl = $('platform-url').value.trim().replace(/\/$/u, '');
  if (!/^https?:\/\//u.test(platformUrl)) {
    setPlatformConnected(false, '平台地址必须使用 HTTP(S)');
    return;
  }
  const granted = await requestSpecificOrigin(platformUrl);
  if (!granted) { setPlatformConnected(false, '没有获得平台访问权限'); return; }
  await readerStore.setSetting('platformUrl', platformUrl);
  await chrome.storage.local.set({ readerPlatformUrl: platformUrl });
  setPlatformConnected(false, '正在打开平台登录…');
  chrome.runtime.sendMessage({ type: 'deep-research:connect' }).catch(() => setPlatformConnected(false, '无法打开平台授权页'));
}

async function disconnectPlatform() {
  const { readerToken } = await chrome.storage.local.get(['readerToken']);
  if (readerToken) {
    try {
      await fetch(`${platformUrl}/api/reading/token/revoke`, { method: 'POST', headers: { authorization: `Bearer ${readerToken}` } });
    } catch {
      // Local disconnect still removes the credential if the platform is down.
    }
  }
  chrome.runtime.sendMessage({ type: 'deep-research:disconnect' }).catch(() => {});
  setPlatformConnected(false, '已断开平台连接');
}

async function syncInsight(insight = lastSavedInsight) {
  if (!insight) { setNotice('先收藏一个选段，再同步到研究库。'); return; }
  const { readerToken } = await chrome.storage.local.get(['readerToken']);
  if (!readerToken) { setNotice('先在设置中连接 Deep Research。'); return; }
  try {
    const response = await fetch(`${platformUrl}/api/reading/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${readerToken}` },
      body: JSON.stringify({
        idempotencyKey: insight.id,
        url: insight.url || insight.document?.url,
        title: insight.title || insight.document?.title,
        quote: insight.quote,
        note: insight.note || '',
        aiAnswer: insight.aiAnswer || undefined,
        anchor: insight.anchor,
        tags: Array.isArray(insight.tags) ? insight.tags : [],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || '研究库同步失败');
    setNotice(payload.deduplicated ? '研究库已存在这条成果，未重复创建。' : '已同步到 Deep Research 研究库。');
  } catch (error) {
    if (error instanceof Error && /令牌|连接|AUTH_NOT_AUTHENTICATED/u.test(error.message)) setPlatformConnected(false, '平台令牌已失效，请重新连接');
    setNotice(error instanceof Error ? error.message : '研究库同步失败');
  }
}

async function syncCurrentSession({ quiet = false } = {}) {
  const { readerToken } = await chrome.storage.local.get(['readerToken']);
  if (!readerToken) { setNotice('先在设置中连接 Deep Research。'); return; }
  const context = documentContext || pageContext || selectionContext;
  if (!context?.url) { setNotice('当前没有可同步的阅读会话。'); return; }
  const image = imageContext?.image;
  const state = {
    selection: selectionContext?.selection || null,
    answer: latestAnswer || '',
    answerStructured: latestStructuredAnswer || null,
    discussion: discussionHistory.slice(-20).map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: String(item.content || '').slice(0, 8_000),
    })),
    discussionScope,
    radarSummaryId: radarEntrySummaryId || null,
    image: image ? {
      id: String(image.id || '').slice(0, 160),
      // Never synchronize a data URL or image bytes. A public HTTPS URL is
      // retained only as a navigational hint for the later local session.
      src: /^https?:\/\//u.test(String(image.src || '')) ? image.src : '',
      alt: String(image.alt || '').slice(0, 2_000),
      width: Number(image.width || 0),
      height: Number(image.height || 0),
    } : null,
    scrollY: Number(pageContext?.scrollY || documentContext?.scrollY || 0),
    scrollHeight: Number(pageContext?.scrollHeight || documentContext?.scrollHeight || 0),
  };
  try {
    const clientId = await readerStore.getClientId();
    const response = await fetch(`${platformUrl}/api/reading/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${readerToken}` },
      body: JSON.stringify({
        clientId,
        idempotencyKey: await readerStore.getSessionSyncKey(context.url, context.contentHash || selectionContext?.selection?.contentHash || null),
        document: {
          url: context.url,
          title: context.title || '未命名页面',
          version: context.contentHash || selectionContext?.selection?.contentHash || null,
        },
        state,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || '阅读会话同步失败');
    if (!quiet) setNotice('当前阅读会话已同步；正文和翻译缓存仍只保存在本地。');
  } catch (error) {
    if (error instanceof Error && /令牌|连接|AUTH_NOT_AUTHENTICATED/u.test(error.message)) setPlatformConnected(false, '平台令牌已失效，请重新连接');
    if (!quiet) setNotice(error instanceof Error ? error.message : '阅读会话同步失败');
  }
}

function platformContext(context, scope) {
  const body = String(context?.body || '').slice(0, 256_000);
  const selection = scope === 'selection' ? context?.selection : undefined;
  return {
    url: context.url,
    title: String(context.title || '当前网页').slice(0, 300),
    language: currentReadingLanguage(),
    scope,
    body,
    ...(typeof context.section === 'string' && context.section ? { section: context.section.slice(0, 80_000) } : {}),
    ...(selection ? { selection } : {}),
  };
}

async function requestPlatformAnswer(sourceContext, question, scope, options = {}) {
  const { readerToken } = await chrome.storage.local.get(['readerToken']);
  if (!readerToken) throw new Error('平台连接已失效，请重新连接');
  const action = options.action === 'explain' ? 'explain' : 'ask';
  const response = await fetch(`${platformUrl}/api/reading/answer/stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${readerToken}`,
    },
    body: JSON.stringify({
      action,
      context: platformContext(sourceContext, scope),
      ...(question ? { prompt: question } : {}),
      history: discussionHistory.slice(-20).map((item) => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: String(item.content || '').slice(0, 8_000),
      })),
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || '平台 AI 暂时不可用');
  }
  if (!response.body) throw new Error('平台 AI 没有返回可读取的内容');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamed = '';
  let completed = null;
  const consume = (frame) => {
    const event = frame.match(/^event:\s*(\S+)/mu)?.[1] || '';
    const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!data) return;
    const payload = JSON.parse(data);
    if (event === 'delta' && typeof payload.text === 'string') {
      streamed += payload.text;
      options.onDelta?.(payload.text);
    } else if (event === 'error') {
      throw new Error(payload.message || '平台 AI 暂时不可用');
    } else if (event === 'done') {
      completed = payload.reading || {
        answer: payload.answer || payload.suggestion || streamed,
        evidence: [],
        background: '',
        inference: '',
        limitations: [],
        warnings: payload.warnings || [],
      };
    }
  };
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    frames.forEach(consume);
    if (chunk.done) break;
  }
  if (buffer.trim()) consume(buffer);
  return completed || {
    answer: streamed,
    evidence: [],
    background: '',
    inference: '',
    limitations: [],
    warnings: [],
  };
}

async function restoreCloudSession() {
  const { readerToken } = await chrome.storage.local.get(['readerToken']);
  if (!readerToken) { setNotice('先在设置中连接 Deep Research。', $('settings-notice')); return; }
  const context = documentContext || pageContext || selectionContext;
  if (!context?.url) { setNotice('当前没有可恢复的阅读页面。', $('settings-notice')); return; }
  try {
    const clientId = await readerStore.getClientId();
    const response = await fetch(`${platformUrl}/api/reading/session?clientId=${encodeURIComponent(clientId)}`, {
      headers: { authorization: `Bearer ${readerToken}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || '云端会话读取失败');
    const currentUrl = readerStore.pageKey(context.url);
    const remote = (Array.isArray(payload.sessions) ? payload.sessions : [])
      .filter((item) => item?.document?.url && readerStore.pageKey(item.document.url) === currentUrl)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (!remote) {
      setNotice('云端没有当前页面的同步会话。', $('settings-notice'));
      return;
    }
    await readerStore.saveSession({
      url: remote.document.url,
      title: remote.document.title || context.title || '未命名页面',
      version: remote.document.version || null,
      ...(remote.state && typeof remote.state === 'object' ? remote.state : {}),
      updatedAt: remote.updatedAt || new Date().toISOString(),
    });
    // Force the local resume path to consume the freshly downloaded state.
    resumedUrls.delete(context.url);
    await resumeSession(context);
    setNotice('已恢复云端阅读会话；正文和翻译缓存仍只保存在本地。', $('settings-notice'));
  } catch (error) {
    if (error instanceof Error && /令牌|连接|AUTH_NOT_AUTHENTICATED/u.test(error.message)) setPlatformConnected(false, '平台令牌已失效，请重新连接');
    setNotice(error instanceof Error ? error.message : '云端会话读取失败', $('settings-notice'));
  }
}

async function testProvider(nextProvider) {
  await requestChat(nextProvider, [{ role: 'user', content: 'Reply with OK only.' }], { temperature: 0 });
  try {
    await testVisionProvider(nextProvider);
    nextProvider.visionReady = true;
  } catch (error) {
    nextProvider.visionReady = false;
    nextProvider.visionError = error instanceof Error ? error.message : '视觉模型检查失败';
  }
}

async function saveSettings() {
  const selectedKind = $('provider-kind')?.value || 'openai';
  const preset = providerPreset(selectedKind);
  const enteredUrl = $('provider-url')?.value.trim() || preset.baseUrl;
  // Keep old local E2E configurations and hand-edited settings working: if a
  // preset's endpoint was replaced, treat it as a custom compatible service.
  const providerKind = selectedKind !== 'custom' && selectedKind !== 'custom-anthropic' && enteredUrl !== preset.baseUrl
    ? 'custom'
    : selectedKind;
  const nextProvider = {
    providerKind,
    baseUrl: enteredUrl,
    model: $('provider-model').value,
    apiKey: $('provider-key').value,
  };
  try {
    // Start the permission request before the first await so Chrome can keep
    // the settings button's user gesture attached to permissions.request().
    const granted = await requestOriginPermission(nextProvider.baseUrl);
    if (!granted) throw new Error('没有获得模型服务域名权限');
    await testProvider(nextProvider);
    provider = await saveProvider(nextProvider);
    setStatus(true, `${provider.model} 已就绪`);
    setNotice(provider.visionReady === false
      ? `模型连接成功；图片翻译不可用时会继续保留原图。${provider.visionError || '当前模型未通过视觉能力检查'}。API Key 只保存在此浏览器。`
      : '模型连接成功，文本与图片能力检查通过。API Key 只保存在此浏览器。', $('settings-notice'));
  } catch (error) {
    provider = null;
    setStatus(false, '连接失败');
    setNotice(error instanceof Error ? error.message : '模型连接失败', $('settings-notice'));
  }
}

async function startFullTranslation() {
  if (!providerReady(provider)) {
    showSettings();
    setNotice('先选择模型服务并填写 API Key。');
    return;
  }
  if (pageContext?.translationDetected && !window.confirm('检测到页面可能已有其他翻译插件。继续会在现有译文旁再次插入内容，是否仍要继续？')) {
    setNotice('已取消全文翻译，请保留一个整页翻译器。');
    return;
  }
  // Request image hosts while the button gesture is still active. A denial
  // must not block text translation; unreadable images remain visible as
  // explicit retry/authorization failures.
  const imagePermission = requestImageOrigins((pageContext?.images || []).filter((image) => image.src));
  const imagePermissionGranted = await imagePermission;
  if (!imagePermissionGranted) setNotice('未获得部分图片站点权限；正文会继续翻译，图片可能需要授权后重试。');
  translationRequested = true;
  fullTranslationEnabled = true;
  translationPaused = false;
  cancellationRequested = false;
  translationRunning = true;
  activeTranslationRun += 1;
  const url = contextUrl();
  const version = pageContext?.contentHash || documentContext?.contentHash || null;
  activeJobRecord = pendingJob?.documentUrl === url
    && pendingJob?.contentHash === version
    && ['queued', 'running', 'cancelled', 'failed', 'completed_with_errors'].includes(pendingJob.status)
    ? pendingJob
    : { id: `translation-${crypto.randomUUID()}`, documentUrl: url, contentHash: version, kind: 'text', status: 'queued', textDone: 0, textTotal: 0, imageDone: 0, imageTotal: 0 };
  failedTranslationItems = Array.isArray(activeJobRecord.failedItems) ? activeJobRecord.failedItems : [];
  pendingJob = null;
  persistJobPatch(activeJobRecord, { status: 'queued', error: undefined });
  translationController?.abort();
  translationController = new AbortController();
  renderProgress();
  setNotice('正在读取当前页面的正文和图片…');
  sendToPage({ type: 'deep-research:request-full-document' });
}

function cancelCurrentTranslation() {
  const job = activeJobRecord;
  if (!job?.id && !translationRunning) return;
  activeTranslationRun += 1;
  translationRequested = false;
  fullTranslationEnabled = false;
  translationPaused = false;
  cancellationRequested = true;
  translationRunning = false;
  translationController?.abort();
  translationController = null;
  if (job?.id) {
    persistJobPatch(job, { status: 'cancelled', error: '用户取消了翻译', tabId: undefined });
    chrome.runtime.sendMessage({ type: 'deep-research:translation-cancel', jobId: job.id }).catch(() => {});
  }
  setNotice('翻译已取消，已完成内容保留。再次点击“全文翻译”可以继续。');
  renderProgress(job?.textDone || 0, job?.textTotal || 0, job?.imageDone || 0, job?.imageTotal || 0);
  saveLocalSession();
}

async function retryTranslationItem(item) {
  if (!item || retryingTranslationId || translationRunning) return;
  if (!providerReady(provider)) {
    showSettings();
    setNotice('先配置模型后再重试。');
    return;
  }
  const context = documentContext || pageContext;
  if (!context) {
    setNotice('当前页面正文尚未提取，无法重试。');
    return;
  }
  const document = makeDocument(context);
  const controller = new AbortController();
  retryingTranslationId = item.id;
  renderTranslationFailures();
  try {
    if (item.kind === 'text') {
      const block = (documentContext?.blocks || context.blocks || []).find((candidate) => candidate.id === item.id);
      if (!block) throw new Error('正文已变化，请重新开启全文翻译');
      const [translated] = await translateBlocks(readingProvider(), document, [block], { signal: controller.signal });
      if (!translated?.text) throw new Error(translated?.error || '正文翻译结果为空');
      sendToPage({ type: 'deep-research:apply-translations', translations: [translated] });
      translatedTextIds.add(item.id);
    } else {
      const image = (documentContext?.images || context.images || []).find((candidate) => candidate.id === item.id);
      if (!image) throw new Error('图片已变化，请重新开启全文翻译');
      const translated = await translateImage(readingProvider(), document, image, { signal: controller.signal, fetchImageBytes: true });
      if (!translated.regions?.length && !translated.fallbackText && !translated.fallbackRegions?.length && !translated.noText && !translated.keptOriginal) throw new Error(translated.note || '图片没有可安全显示的译文');
      if (translated.regions?.length || translated.fallbackText || translated.fallbackRegions?.length) sendToPage({ type: 'deep-research:apply-image-translations', translations: [translated] });
      translatedImageIds.add(item.id);
    }
    failedTranslationItems = failedTranslationItems.filter((candidate) => candidate.id !== item.id);
    persistJobPatch(activeJobRecord, {
      failedItems: failedTranslationItems,
      status: failedTranslationItems.length ? 'completed_with_errors' : 'completed',
      completedAt: new Date().toISOString(),
    });
    setNotice(failedTranslationItems.length ? `已完成一项，还剩 ${failedTranslationItems.length} 项。` : '失败项已全部完成。');
  } catch (error) {
    const message = error instanceof Error ? error.message : '重试失败';
    failedTranslationItems = failedTranslationItems.map((candidate) => candidate.id === item.id ? { ...candidate, error: message } : candidate);
    persistJobPatch(activeJobRecord, { failedItems: failedTranslationItems, status: 'completed_with_errors', error: message });
    setNotice(message);
  } finally {
    retryingTranslationId = null;
    renderProgress(activeJobRecord?.textDone || 0, activeJobRecord?.textTotal || 0, activeJobRecord?.imageDone || 0, activeJobRecord?.imageTotal || 0);
  }
}

async function processDocument(context, runId = activeTranslationRun) {
  if (!translationRequested || !translationRunning || runId !== activeTranslationRun) return;
  const job = activeJobRecord;
  context = boundTaskContext({ ...context, targetLanguage: currentReadingLanguage() });
  documentContext = context;

  // Long-running translation belongs to the MV3 service worker. The side
  // panel is a disposable view: closing it must not abort an in-flight job.
  // If the worker cannot accept the task, retain the local fallback below so
  // a browser with an unusual extension runtime still remains usable.
  if (job?.id && Number.isInteger(activeTabId)) {
    try {
      const accepted = await chrome.runtime.sendMessage({
        type: 'deep-research:translation-start',
        jobId: job.id,
        tabId: activeTabId,
        context,
        reapply: job.status === 'completed',
      });
      if (accepted?.ok) {
        persistJobPatch(job, { workerManaged: true, status: job.status === 'completed' ? 'queued' : job.status || 'queued' });
        return;
      }
    } catch {
      // Fall through to the panel-local executor below.
    }
  }
  const document = makeDocument(context);
  const blocks = Array.isArray(context.blocks) ? context.blocks : [];
  const images = Array.isArray(context.images) ? context.images : [];
  const processedTextIds = Array.isArray(job?.processedTextIds) ? job.processedTextIds : [];
  const processedImageIds = Array.isArray(job?.processedImageIds) ? job.processedImageIds : [];
  const blockIds = blocks.map((block) => block.id).filter(Boolean);
  const imageIds = images.map((image) => image.id).filter(Boolean);
  let textDone = 0;
  let imageDone = 0;
  const translatableBlocks = blocks.filter((block) => block.kind !== 'code');
  const skippedCodeBlocks = blocks.length - translatableBlocks.length;
  textDone = skippedCodeBlocks;
  persistJobPatch(job, {
    status: 'running',
    documentUrl: context.url || job?.documentUrl || '',
    contentHash: context.contentHash || context.version || job?.contentHash || null,
    textDone: Math.max(Number(job?.textDone) || 0, processedTextIds.length),
    textTotal: Math.max(Number(job?.textTotal) || 0, new Set([...processedTextIds, ...blockIds]).size),
    imageDone: Math.max(Number(job?.imageDone) || 0, processedImageIds.length),
    imageTotal: Math.max(Number(job?.imageTotal) || 0, new Set([...processedImageIds, ...imageIds]).size),
    processedTextIds,
    processedImageIds,
  });
  renderProgress(Math.max(Number(job?.textDone) || 0, processedTextIds.length), Math.max(Number(job?.textTotal) || 0, new Set([...processedTextIds, ...blockIds]).size), Math.max(Number(job?.imageDone) || 0, processedImageIds.length), Math.max(Number(job?.imageTotal) || 0, new Set([...processedImageIds, ...imageIds]).size));
  const imageLimitNotice = context.imageTruncated
    ? `图片超过处理上限，已列出 ${images.length}/${context.imageCandidateCount || images.length} 张，未处理部分已明确保留。`
    : '';
  setNotice(`正文翻译会按块处理；图片无法翻译时保留原图并继续。${imageLimitNotice ? `\n${imageLimitNotice}` : ''}`);
  try {
    const translations = await translateBlocks(readingProvider(), document, translatableBlocks, {
      signal: translationController.signal,
      // Apply each completed block immediately. Waiting for every paragraph
      // made a long page feel frozen even though the model was already
      // returning usable results.
      onResult: (item) => {
        if (runId !== activeTranslationRun || !item?.text) return;
        translatedTextIds.add(item.id);
        sendToPage({ type: 'deep-research:apply-translations', translations: [item] });
      },
      onProgress: (done) => {
        textDone = Math.max(Number(job?.textDone) || 0, done + skippedCodeBlocks);
        renderProgress(textDone, Math.max(Number(job?.textTotal) || 0, new Set([...processedTextIds, ...blockIds]).size), imageDone, Math.max(Number(job?.imageTotal) || 0, new Set([...processedImageIds, ...imageIds]).size));
        persistJobPatch(job, { textDone, textTotal: Math.max(Number(job?.textTotal) || 0, new Set([...processedTextIds, ...blockIds]).size) });
      },
    });
    job.processedTextIds = mergeProcessedIds(processedTextIds, [
      ...translations.filter((item) => item.text || item.error).map((item) => item.id),
      ...blocks.filter((block) => block.kind === 'code').map((block) => block.id),
    ]);
    const usableTranslations = translations.filter((item) => item.text);
    if (runId !== activeTranslationRun) return;
    if (usableTranslations.length) {
      usableTranslations.forEach((item) => translatedTextIds.add(item.id));
      sendToPage({ type: 'deep-research:apply-translations', translations: usableTranslations });
    }
    const imageTranslations = [];
    for (const image of images) {
      if (translationController.signal.aborted) throw new DOMException('翻译已取消', 'AbortError');
      try {
        const translated = await translateImage(readingProvider(), document, image, { signal: translationController.signal, fetchImageBytes: true });
        imageTranslations.push(translated);
      } catch (error) {
        imageTranslations.push({ ...image, regions: [], confidence: 0, note: error instanceof Error ? error.message : '图片翻译失败' });
      }
      imageDone += 1;
      job.processedImageIds = mergeProcessedIds(processedImageIds, imageTranslations.map((item) => item.id).filter(Boolean));
      renderProgress(textDone, Math.max(Number(job?.textTotal) || 0, new Set([...processedTextIds, ...blockIds]).size), Math.max(Number(job?.imageDone) || 0, job.processedImageIds.length), Math.max(Number(job?.imageTotal) || 0, new Set([...job.processedImageIds, ...imageIds]).size));
      persistJobPatch(job, { imageDone: Math.max(Number(job?.imageDone) || 0, job.processedImageIds.length), imageTotal: Math.max(Number(job?.imageTotal) || 0, new Set([...job.processedImageIds, ...imageIds]).size), processedImageIds: job.processedImageIds });
    }
    if (runId !== activeTranslationRun) return;
    const usableImageTranslations = imageTranslations.filter((item) => item.regions?.length || item.fallbackText || item.fallbackRegions?.length);
    if (usableImageTranslations.length) {
      usableImageTranslations.forEach((item) => translatedImageIds.add(item.id));
      sendToPage({ type: 'deep-research:apply-image-translations', translations: usableImageTranslations });
    }
    const currentFailures = translations.filter((item) => item.error).map((item) => ({
      id: item.id,
      kind: 'text',
      label: item.sourceText?.slice(0, 96) || item.id,
      error: item.error,
    }));
    currentFailures.push(...imageTranslations
      .filter((item) => !item.regions?.length && !item.fallbackText && !item.noText && !item.keptOriginal)
      .map((item) => ({
        id: item.id,
        kind: 'image',
        label: item.alt || item.src || item.id,
        error: item.note || '图片翻译失败',
      })));
    const resolvedIds = [
      ...translations.filter((item) => item.text).map((item) => item.id),
      ...imageTranslations.filter((item) => item.regions?.length || item.fallbackText || item.noText || item.keptOriginal).map((item) => item.id),
    ].filter(Boolean);
    failedTranslationItems = mergeTranslationFailures(failedTranslationItems, currentFailures, resolvedIds);
    const imageWarnings = imageTranslations
      .filter((item) => item.noText || item.keptOriginal || (item.fallbackText && item.note) || item.sourceWarning)
      .map((item) => `图片 ${item.id}: ${[item.sourceWarning, item.skipped ? '当前模型不可用，保留原图并继续' : '', item.noText ? '未发现可可靠读取的文字' : '', item.keptOriginal && !item.skipped ? '图片文字为技术标识符，保留原文' : '', item.note].filter(Boolean).join('；')}`);
    renderTranslationFailures();
    const failures = failedTranslationItems.map((item) => `${item.kind === 'image' ? '图片' : '正文'} ${item.id}: ${item.error}`);
    setNotice(failures.length
      ? `翻译完成，但有 ${failures.length} 项需要重试。\n${[...failures, ...imageWarnings].slice(0, 5).join('\n')}`
      : imageWarnings.length
        ? `全文翻译完成。${imageWarnings.slice(0, 3).join('\n')}`
        : '全文翻译完成。可以滚动阅读，或选择一段文字继续追问。');
    if (runId === activeTranslationRun) persistJobPatch(job, {
      status: failedTranslationItems.length ? 'completed_with_errors' : 'completed',
      textDone,
      textTotal: Math.max(Number(job?.textTotal) || 0, new Set([...job.processedTextIds, ...blockIds]).size),
      imageDone: Math.max(Number(job?.imageDone) || 0, job.processedImageIds.length),
      imageTotal: Math.max(Number(job?.imageTotal) || 0, new Set([...job.processedImageIds, ...imageIds]).size),
      processedTextIds: job.processedTextIds,
      processedImageIds: job.processedImageIds,
      failedItems: failedTranslationItems,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (runId === activeTranslationRun) {
      if (error instanceof DOMException && error.name === 'AbortError') setNotice('翻译已暂停。再次点击全文翻译会从缓存结果继续。');
      else setNotice(error instanceof Error ? error.message : '全文翻译失败');
    }
    if (runId === activeTranslationRun) persistJobPatch(job, { status: error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : '全文翻译失败' });
  } finally {
    if (runId === activeTranslationRun) {
      translationRunning = false;
      renderProgress(textDone, Math.max(Number(job?.textTotal) || 0, new Set([...processedTextIds, ...blockIds]).size), imageDone, Math.max(Number(job?.imageTotal) || 0, new Set([...processedImageIds, ...imageIds]).size));
      saveLocalSession();
    }
  }
}

const FULL_PAGE_SUMMARY_PROMPT = '请用四个编号小节总结整篇技术文章：1）文章解决的问题和核心结论；2）关键机制或架构；3）重要取舍、适用边界和失败条件；4）值得继续核对的原文证据。每节最多 3 个要点，总回答控制在 1200 个汉字以内；证据最多 4 条，每条引用不超过 160 个字符。只基于当前页面正文，不要把未出现在原文中的信息说成文章结论。';
const ARTICLE_MAP_PROMPT = '请把整篇技术文章整理成一张可导航的文章地图：列出文章主线、章节或主题之间的依赖关系、每一部分解决的问题，以及读者应该先读什么。只基于当前页面正文，无法确认的关系请明确标记。';
const ARCHITECTURE_PROMPT = '请从技术实现角度分析整篇文章，重点说明组件、数据流、控制流、关键接口和原文中明确出现的实现线索；如果原文没有代码，不要生成完整实现，只列出可核对的实现问题、接口边界和推断。把原文明确内容、必要背景和 AI 推断分开。只基于当前页面正文。';
const TRADEOFFS_PROMPT = '请审查整篇技术文章的风险与取舍：明确列出前提、收益、成本、失败条件、反例和需要继续核对的地方。不要把一般经验冒充原文结论，并为原文依据提供可定位的证据。';
const SELECTION_SUMMARY_PROMPT = '请用 3 到 5 个要点总结当前选段，说明它在整篇文章中的作用，并保留关键技术术语。只基于当前选段及所在小节。';

function discussionPrompt(scope, intent) {
  if (intent === 'summary') return FULL_PAGE_SUMMARY_PROMPT;
  if (intent === 'map') return ARTICLE_MAP_PROMPT;
  if (intent === 'architecture') return ARCHITECTURE_PROMPT;
  if (intent === 'tradeoffs') return TRADEOFFS_PROMPT;
  if (intent === 'selection-summary') return SELECTION_SUMMARY_PROMPT;
  if (intent === 'translate') return `请将当前选段翻译成${currentReadingLanguage()}，保留 API、类名、函数名、命令、代码和技术标识符；只翻译自然语言，不要补充解释。`;
  if (intent === 'explain') return scope === 'image' ? '请解释这张技术图示。' : '请解释当前技术内容，指出它解决的问题、关键机制和一个具体例子。';
  return scope === 'image' ? '请围绕当前技术图示回答问题。' : '';
}

function discussionUserLabel(scope, intent, question = '') {
  const explicitQuestion = String(question || '').trim();
  if (explicitQuestion) return explicitQuestion;
  if (intent === 'summary') return '总结本页';
  if (intent === 'map') return '梳理文章地图';
  if (intent === 'architecture') return '分析关键机制';
  if (intent === 'tradeoffs') return '审查风险与取舍';
  if (intent === 'selection-summary') return '总结当前选段';
  if (intent === 'translate') return '翻译当前选段';
  if (intent === 'explain') {
    if (scope === 'image') return '解读当前图示';
    if (scope === 'selection') return '解释当前选段';
    return '解释当前页面';
  }
  if (scope === 'image') return '围绕当前图示提问';
  if (scope === 'selection') return '围绕当前选段提问';
  return '围绕当前页面提问';
}

function revealDiscussion({ focusInput = false } = {}) {
  window.setTimeout(() => {
    $('discussion-section')?.scrollIntoView({ behavior: 'auto', block: 'start' });
    if (focusInput) $('question-input')?.focus({ preventScroll: true });
  }, 0);
}

function openDiscussion(scope = 'page', intent = 'ask') {
  const nextScope = scope === 'selection' && selectionContext?.selection?.quote
    ? 'selection'
    : scope === 'image' && imageContext?.image
      ? 'image'
      : 'page';
  discussionScope = nextScope;
  discussionIntent = DISCUSSION_INTENTS.has(intent) ? intent : 'ask';
  discussionOpen = true;
  const context = activeDiscussionContext(nextScope);
  show($('discussion-section'), true);
  renderDiscussionContext(nextScope, discussionIntent, context);
  if ($('question-input')) {
    $('question-input').placeholder = nextScope === 'selection'
      ? '只针对当前选段提问，例如：它为什么这样设计？'
      : nextScope === 'image'
        ? '针对当前图示提问，例如：这条数据流的瓶颈在哪里？'
        : '针对整篇文章提问，例如：作者的主要取舍是什么？';
    revealDiscussion({ focusInput: true });
  }
}

function setDiscussionScope(scope) {
  const requested = scope === 'selection' || scope === 'image' ? scope : 'page';
  const nextScope = requested === 'selection' && selectionContext?.selection?.quote
    ? 'selection'
    : requested === 'image' && imageContext?.image
      ? 'image'
      : requested === 'page'
        ? 'page'
        : null;
  if (!nextScope) {
    setNotice(requested === 'selection' ? '先在原网页选择一段正文。' : '先在原网页点击一张图示。');
    return;
  }
  discussionScope = nextScope;
  discussionIntent = 'ask';
  discussionOpen = true;
  openDiscussion(nextScope, 'ask');
  saveLocalSession();
}

async function handlePageAction(action) {
  const normalized = String(action || '').trim();
  if (!normalized) return;
  if (!pageContext && !documentContext) {
    pendingPageAction = normalized;
    setNotice('正在读取当前页面，动作会在正文准备好后继续。');
    sendToPage({ type: 'deep-research:request-page' });
    return;
  }
  pendingPageAction = null;
  if (normalized === 'translate') {
    await startFullTranslation();
    return;
  }
  const intent = normalized;
  if (['summary', 'map', 'architecture', 'tradeoffs'].includes(intent)) {
    void explainOrAsk('', 'page', intent);
    return;
  }
  openDiscussion('page', 'ask');
}

async function explainOrAsk(question = '', scope = discussionScope, intent = discussionIntent) {
  interactionGeneration += 1;
  const sourceContext = scope === 'page' || scope === 'image' ? (documentContext || pageContext) : selectionContext;
  const image = scope === 'image' ? imageContext?.image : null;
  if (!sourceContext || (scope === 'selection' && !sourceContext.selection?.quote) || (scope === 'image' && !image)) {
    setNotice(scope === 'image' ? '先在原网页点击一张图示的“解读”按钮。' : '先在原网页选择一段正文，或先打开整页讨论。');
    return;
  }
  if (scope === 'page' && !contextHasReadableBody(sourceContext)) {
    pageReadState = 'error';
    updatePageContextUi(sourceContext);
    renderPersistentComposer(scope);
    setNotice('没有提取到可用于问答的正文。请重新加载页面，或先选择一段原文后提问。');
    return;
  }
  if (scope === 'image' && !providerReady(provider)) {
    showSettings();
    setNotice('图片理解仍需要独立模式的视觉模型配置。');
    return;
  }
  if (!platformModeReady() && !providerReady(provider)) { showSettings(); setNotice('先配置模型后再解读。'); return; }
  const normalizedIntent = DISCUSSION_INTENTS.has(intent) ? intent : 'ask';
  discussionScope = scope;
  discussionIntent = normalizedIntent;
  discussionOpen = true;
  renderDiscussionContext(scope, normalizedIntent, sourceContext);
  $('answer-output').textContent = '正在阅读这段原文并核对证据…';
  show($('answer-output'), true);
  latestStructuredAnswer = null;
  renderStructuredAnswer(null);
  show($('discussion-section'), true);
  revealDiscussion();
  discussionController?.abort();
  discussionController = new AbortController();
  discussionRunning = true;
  renderPersistentComposer(scope);
  latestAnswer = '';
  let streamBuffer = '';
  try {
    const intentPrompt = discussionPrompt(scope, normalizedIntent);
    const userMessage = discussionUserLabel(scope, normalizedIntent, question);
    const requestPrompt = question || intentPrompt;
    const result = scope !== 'image' && platformModeReady()
      ? await requestPlatformAnswer(sourceContext, requestPrompt, scope, {
        action: !question && normalizedIntent === 'explain' ? 'explain' : 'ask',
        signal: discussionController.signal,
        onDelta: (delta) => {
          streamBuffer += delta;
          $('answer-output').textContent = streamBuffer || '正在通过调研平台核对原文证据…';
        },
      })
      : scope === 'image'
      ? await explainImage(provider, sourceContext, image, question, discussionHistory, {
        signal: discussionController.signal,
        onDelta: (delta) => {
          streamBuffer += delta;
          $('answer-output').textContent = streamAnswerPreview(streamBuffer) || '正在读取图示、整理回答和核对文字证据…';
        },
      })
      : await explainSelection(provider, { ...sourceContext, scope }, question, discussionHistory, {
        signal: discussionController.signal,
        // Reasoning-capable providers may spend output tokens on hidden
        // thinking before emitting the JSON envelope. Keep the visible
        // answer short in the prompt, but leave enough budget for that
        // envelope to arrive intact.
        maxTokens: normalizedIntent === 'summary' ? 6000 : 5000,
        onDelta: (delta) => {
          streamBuffer += delta;
          $('answer-output').textContent = streamAnswerPreview(streamBuffer) || '正在整理回答、原文证据和适用边界…';
        },
      });
    latestStructuredAnswer = typeof result === 'string' ? { answer: result, evidence: [], background: '', inference: '', limitations: [], warnings: [] } : result;
    latestAnswer = latestStructuredAnswer.answer || '';
    discussionHistory = [
      ...discussionHistory,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: latestAnswer },
    ].slice(-20);
    discussionRunning = false;
    $('question-input').value = '';
    renderPersistentComposer(scope);
    renderConversation();
    renderStructuredAnswer(latestStructuredAnswer);
    show($('answer-output'), false);
    saveLocalSession();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      discussionRunning = false;
      show($('answer-output'), false);
      renderPage();
      return;
    }
    discussionRunning = false;
    renderPersistentComposer(scope);
    latestAnswer = '';
    latestStructuredAnswer = null;
    $('answer-output').textContent = '';
    renderConversation();
    show($('answer-output'), false);
    renderStructuredAnswer(null);
    setNotice(error instanceof Error ? error.message : '解读失败');
  }
}

function openAnnotationDialog(annotation = null) {
  const source = annotation || (selectionContext?.selection?.quote ? {
    document: {
      url: selectionContext.url,
      title: selectionContext.title,
      version: selectionContext.contentHash || selectionContext.version || selectionContext.selection.contentHash || null,
    },
    anchor: selectionContext.selection,
    note: '',
  } : null);
  if (!source?.anchor?.quote) { setNotice('先在原网页选择一段正文。'); return; }
  editingAnnotation = annotation;
  const dialog = ensureAnnotationDialog();
  show($('page-view'), false);
  show($('empty-view'), false);
  show($('settings-view'), false);
  show(ensureSaveDialog(), false);
  show(dialog, true);
  $('annotation-source-title').textContent = source.document?.title || selectionContext?.title || '当前页面';
  $('annotation-quote').value = source.anchor.quote;
  $('annotation-note').value = source.note || '';
  $('annotation-notice').textContent = '';
  show($('annotation-notice'), false);
  $('annotation-note').focus();
}

async function confirmAnnotation() {
  const anchor = editingAnnotation?.anchor || selectionContext?.selection;
  const context = selectionContext || documentContext || pageContext;
  const note = $('annotation-note').value.trim();
  if (!anchor?.quote || !context?.url) { setNotice('当前原文锚点已失效，请重新选择。', $('annotation-notice')); return; }
  const version = context.contentHash || context.version || anchor.contentHash || null;
  if (!version) { setNotice('当前页面还没有稳定版本指纹，请等待正文提取后重试。', $('annotation-notice')); return; }
  const saved = await readerStore.saveAnnotation({
    ...(editingAnnotation || {}),
    id: editingAnnotation?.id,
    document: { url: context.url, title: context.title || '未命名页面', version },
    anchor: { ...anchor, contentHash: anchor.contentHash || version },
    note,
  });
  editingAnnotation = null;
  sendToPage({ type: 'deep-research:apply-annotation', annotation: saved });
  showReading();
  setNotice('已保存标注，并在原文中高亮。');
  await updateLibrary();
}

function openSaveDialog(insight = null) {
  const source = insight || latestAnswerSource() || (selectionContext?.selection?.quote ? {
    title: selectionContext.title,
    url: selectionContext.url,
    quote: selectionContext.selection.quote,
    note: '',
    aiAnswer: latestAnswer,
    anchor: selectionContext.selection,
    tags: [],
  } : null);
  if (!source) { setNotice('先生成回答，或在原网页选择一段正文。'); return; }
  editingInsight = insight;
  pendingInsightSource = source;
  const dialog = ensureSaveDialog();
  show($('page-view'), false);
  show($('empty-view'), false);
  show($('settings-view'), false);
  show(ensureAnnotationDialog(), false);
  show(dialog, true);
  $('save-source-title').textContent = source.title || source.document?.title || '当前页面';
  $('save-quote').value = source.quote || '';
  $('save-note').value = source.note || '';
  $('save-ai-answer').value = source.aiAnswer || '';
  $('save-tags').value = Array.isArray(source.tags) ? source.tags.join(', ') : '';
  $('save-notice').textContent = '';
  show($('save-notice'), false);
  if (source.fallbackWarning) setNotice(source.fallbackWarning, $('save-notice'));
  $('save-quote').focus();
}

async function confirmSaveInsight() {
  const quote = $('save-quote').value.trim();
  if (!quote) { setNotice('至少保留一段原文摘录。', $('save-notice')); return; }
  const source = editingInsight || pendingInsightSource || latestAnswerSource() || selectionContext;
  const url = editingInsight?.url || editingInsight?.document?.url || source?.url || source?.document?.url || selectionContext?.url || '';
  const title = editingInsight?.title || editingInsight?.document?.title || source?.title || source?.document?.title || selectionContext?.title || '未命名页面';
  if (!url) { setNotice('当前页面来源缺失，请重新选择原文。', $('save-notice')); return; }
  const tags = $('save-tags').value.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 10);
  const sourceVersion = source?.document?.version
    || source?.version
    || selectionContext?.contentHash
    || selectionContext?.version
    || selectionContext?.selection?.contentHash
    || editingInsight?.document?.version
    || null;
  const saved = await readerStore.saveInsight({
    ...(editingInsight || {}),
    id: editingInsight?.id,
    title,
    url,
    document: { url, title, version: sourceVersion },
    quote,
    note: $('save-note').value.trim(),
    aiAnswer: $('save-ai-answer').value.trim(),
    tags,
    // Editing a quote invalidates its precise anchor. Keep the anchor only
    // when it is still byte-for-byte identical to the original selection.
    anchor: editingInsight && editingInsight.anchor && editingInsight.anchor.quote === quote
      ? editingInsight.anchor
      : source?.anchor && source.anchor.quote === quote
        ? source.anchor
        : selectionContext?.selection && selectionContext.selection.quote === quote
          ? selectionContext.selection
        : undefined,
  });
  lastSavedInsight = saved;
  editingInsight = null;
  pendingInsightSource = null;
  // The token in local storage is the durable source of truth.  The callback
  // message and the panel's in-memory flag may arrive in either order, so a
  // just-confirmed save must re-read it before deciding whether to expose the
  // sync action.
  const stored = await chrome.storage.local.get(['readerToken']);
  if (stored.readerToken && !platformConnected) setPlatformConnected(true, `已连接 · ${platformUrl}`);
  showReading();
  show($('sync-selection'), Boolean(stored.readerToken) || platformConnected);
  if (platformModeReady()) {
    await syncInsight(saved);
  } else {
    setNotice('已保存到本地阅读库。', $('notice'));
  }
  await updateLibrary();
}

function saveInsight() {
  openSaveDialog();
}

function currentActivationOrigin() {
  const value = activationNeeded?.url || '';
  try {
    const url = new URL(value);
    if (!/^https?:$/u.test(url.protocol)) return null;
    return { origin: `${url.origin}/*`, tabId: activationNeeded?.tabId };
  } catch {
    return null;
  }
}

async function requestCurrentSiteAccess() {
  const target = currentActivationOrigin();
  if (!Number.isInteger(target?.tabId) || !chrome.permissions?.request) {
    setNotice('当前页面无法申请访问权限，请切换到普通网页后重试。');
    return;
  }
  // Start the permission request before the first await so Chrome keeps the
  // user gesture from the side-panel button attached to this prompt.
  const permissionRequest = chrome.permissions.request({ origins: [target.origin] });
  try {
    const granted = await permissionRequest;
    if (!granted) {
      setNotice('没有获得当前站点权限；页面内容仍未读取。');
      return;
    }
    const result = await chrome.runtime.sendMessage({ type: 'deep-research:activate-current-page', tabId: target.tabId });
    if (!result?.ok) {
      setNotice(result?.error || '当前页面无法启用阅读。');
      return;
    }
    activationNeeded = null;
    setNotice('已启用当前站点，正在读取页面正文…');
    renderEmptyState();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : '站点权限申请失败。');
  }
}

async function activateCurrentPage() {
  if (activationNeeded?.reason === 'unsupported') {
    setNotice('当前页面不支持阅读，请切换到公开文章、文档或 GitHub 页面。');
    return;
  }
  if (activationNeeded?.reason === 'unknown') {
    // Clear the stale metadata state and retry the active-tab lookup. This
    // keeps the recovery button useful on browsers that briefly redact URL
    // metadata while a tab is still resolving.
    activationNeeded = null;
  }
  if (activationNeeded?.reason === 'permission') {
    await requestCurrentSiteAccess();
    return;
  }
  let tabId = activeTabId;
  if (!Number.isInteger(tabId)) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    tabId = tab?.id;
  }
  if (!Number.isInteger(tabId)) {
    setNotice('没有找到当前页面，请重新点击扩展按钮。');
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: 'deep-research:activate-current-page', tabId }).catch(() => null);
  if (!result?.ok) setNotice(result?.error || '当前页面无法启用阅读。');
}

function handleEmptyPrimary() {
  if (!providerReady(provider) && !platformModeReady()) {
    showSettings();
    return;
  }
  void activateCurrentPage();
}

function showSettings() {
  show($('page-view'), false); show($('empty-view'), false); show(ensureSaveDialog(), false); show(ensureAnnotationDialog(), false); show($('settings-view'), true); applyProviderFields(); updateReadingModeUi();
}

function showReading() {
  show($('settings-view'), false); show(ensureSaveDialog(), false); show(ensureAnnotationDialog(), false); renderPage(); updateLibrary();
}

async function openHistoryPage() {
  try {
    await sessionSaveQueue;
    window.location.href = chrome.runtime.getURL('reading-history.html?surface=sidepanel');
  } catch {
    setNotice('无法打开侧栏内的阅读历史。');
  }
}

async function restorePendingPageAction() {
  const stored = await chrome.storage.session?.get?.('readerPendingPageAction').catch?.(() => ({}));
  const pending = stored?.readerPendingPageAction;
  if (!pending?.action || !Number.isFinite(Number(pending.createdAt)) || Date.now() - Number(pending.createdAt) > 15_000) {
    if (pending) await chrome.storage.session?.remove?.('readerPendingPageAction').catch?.(() => {});
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (Number.isInteger(pending.tabId) && Number.isInteger(tab?.id) && pending.tabId !== tab.id) return;
  await chrome.storage.session?.remove?.('readerPendingPageAction').catch?.(() => {});
  pendingPageAction = pending.action;
  if (pageContext || documentContext) {
    const action = pendingPageAction;
    pendingPageAction = null;
    void handlePageAction(action);
  }
}

function downloadJson(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `deep-research-reading-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'deep-research:page-activation-needed') {
    activationNeeded = {
      tabId: Number.isInteger(message.tabId) ? message.tabId : null,
      windowId: Number.isInteger(message.windowId) ? message.windowId : null,
      url: typeof message.url === 'string' ? message.url : '',
      reason: message.reason === 'unsupported' || message.reason === 'unknown' ? message.reason : 'permission',
    };
    pageReadState = message.reason === 'unsupported' ? 'error' : 'idle';
    if (Number.isInteger(message.tabId)) activeTabId = message.tabId;
    renderPage();
    if (activationNeeded.reason === 'permission') setNotice('此站点尚未启用；点击“启用此站点”后才会读取页面。');
    return;
  }
  if (message.type === 'deep-research:connection-state') {
    platformStateEvents += 1;
    setPlatformConnected(Boolean(message.connected), message.connected ? `已连接 · ${platformUrl}` : (message.status || '未连接'));
    return;
  }
  if (message.type === 'deep-research:clear-page') {
    if (activeJobRecord?.id) chrome.runtime.sendMessage({ type: 'deep-research:translation-cancel', jobId: activeJobRecord.id }).catch(() => {});
    activeTranslationRun += 1; sessionGeneration += 1; sessionResumeTasks.clear(); discussionController?.abort(); discussionRunning = false; activeJobRecord = null; pendingJob = null; failedTranslationItems = []; retryingTranslationId = null; pageContext = null; documentContext = null; selectionContext = null; imageContext = null; latestAnswer = ''; latestStructuredAnswer = null; discussionHistory = []; discussionScope = 'page'; discussionIntent = 'ask'; discussionOpen = false; activeSessionTitle = ''; resumedUrls.clear(); activationNeeded = null; pageReadState = 'idle'; lastSavedInsight = null; pendingInsightSource = null; translationRequested = false; fullTranslationEnabled = false; translationPaused = false; translationRunning = false; radarEntryPlatformUrl = ''; radarEntryPromptKey = ''; radarEntrySummaryId = ''; translatedTextIds.clear(); translatedImageIds.clear(); sendToPage({ type: 'deep-research:clear-annotations' }); renderPage(); return;
  }
  if (message.type === 'deep-research:page-context' && message.context) {
    if (Number.isInteger(message.tabId)) activeTabId = message.tabId;
    activationNeeded = null;
    pageReadState = contextHasReadableBody(message.context) ? 'ready' : 'error';
    const documentChanged = Boolean(pageContext?.url && pageContext.url !== message.context.url);
    const contentChanged = Boolean(
      pageContext?.url === message.context.url
      && pageContext?.contentHash
      && message.context.contentHash
      && pageContext.contentHash !== message.context.contentHash,
    );
    pageContext = message.context;
    const documentContextChanged = Boolean(documentContext?.url && documentContext.url !== pageContext.url);
    if (documentChanged || contentChanged || documentContextChanged) {
      if ((documentChanged || contentChanged) && activeJobRecord?.id) chrome.runtime.sendMessage({ type: 'deep-research:translation-cancel', jobId: activeJobRecord.id }).catch(() => {});
      if (documentChanged || contentChanged) {
        sessionGeneration += 1;
        sessionResumeTasks.clear();
        activeTranslationRun += 1;
        translationRunning = false;
        pendingJob = null;
        sendToPage({ type: 'deep-research:restore-translations' });
      }
      if (documentChanged) {
        translationRequested = false;
        fullTranslationEnabled = false;
        translationPaused = false;
      }
      documentContext = null;
      imageContext = null;
      selectionContext = null;
      latestAnswer = '';
      latestStructuredAnswer = null;
      discussionHistory = [];
      discussionScope = 'page';
      discussionIntent = 'ask';
      discussionOpen = false;
      activeSessionTitle = '';
      if (documentChanged || contentChanged) resumedUrls.delete(message.context.url);
      failedTranslationItems = [];
      translatedTextIds.clear();
      translatedImageIds.clear();
      if (documentChanged) setNotice('页面已切换，旧的证据和讨论已清除。请在新页面重新开始。');
      else if (contentChanged) setNotice('页面内容已变化，旧的证据和讨论已失效；请重新选择原文。');
    }
    applyRadarEntryContext(pageContext);
    renderPage(); setPlatformConnected(platformConnected); void applyAnnotationsForContext(pageContext);
    // Restore an exact page-version session before persisting the fresh page
    // snapshot. Otherwise the first page-context event could overwrite a
    // renamed session (and its discussion) with an empty default session.
    const contextForResume = pageContext;
    const interactionAtResumeStart = interactionGeneration;
    void (async () => {
      await resumeSession(contextForResume);
      if (interactionAtResumeStart !== interactionGeneration || contextForResume !== pageContext) return;
      saveLocalSession();
      await findPendingTranslation(contextForResume);
    })();
    // When a page appends or edits content during a full translation, the
    // old overlays must be removed before taking the new snapshot. The
    // `translations-restored` event below is the single hand-off point that
    // starts the replacement job; doing it here as well creates a race where
    // the restore event cancels the just-started request.
    if (contentChanged && fullTranslationEnabled && !translationPaused && providerReady(provider)) {
      translationRequested = true;
      return;
    }
    if (fullTranslationEnabled && !translationPaused && !translationRunning && providerReady(provider) && Array.isArray(pageContext.blocks)) {
      const pendingBlocks = pageContext.blocks.filter((block) => !translatedTextIds.has(block.id) && !pageContext.translatedBlockIds?.includes(block.id));
      const pendingImages = (pageContext.images || []).filter((image) => !translatedImageIds.has(image.id) && !pageContext.translatedImageIds?.includes(image.id));
      if (pendingBlocks.length || pendingImages.length) {
        translationRunning = true;
        activeTranslationRun += 1;
        translationController?.abort();
        translationController = new AbortController();
        void processDocument({ ...pageContext, blocks: pendingBlocks, images: pendingImages }, activeTranslationRun);
      }
    }
    if (pendingPageAction && (documentContext || pageContext)) {
      const action = pendingPageAction;
      pendingPageAction = null;
      window.setTimeout(() => void handlePageAction(action), 0);
    }
  }
  if (message.type === 'deep-research:reading-progress' && message.progress?.url === pageContext?.url) {
    pageContext = { ...pageContext, ...message.progress }; saveLocalSession();
  }
  if (message.type === 'deep-research:full-document' && message.context) {
    if (Number.isInteger(message.tabId)) activeTabId = message.tabId;
    void processDocument(message.context, activeTranslationRun);
  }
  if (message.type === 'deep-research:translation-progress' && message.jobId === activeJobRecord?.id && !retryingTranslationId) {
    activeJobRecord = { ...activeJobRecord, ...(message.progress || {}) };
    failedTranslationItems = Array.isArray(activeJobRecord.failedItems) ? activeJobRecord.failedItems : failedTranslationItems;
    renderProgress(activeJobRecord.textDone || 0, activeJobRecord.textTotal || 0, activeJobRecord.imageDone || 0, activeJobRecord.imageTotal || 0);
  }
  if (message.type === 'deep-research:translation-complete' && message.jobId === activeJobRecord?.id && !retryingTranslationId) {
    activeJobRecord = { ...activeJobRecord, ...(message.job || {}) };
    failedTranslationItems = Array.isArray(message.failures) ? message.failures : (activeJobRecord.failedItems || []);
    translationRunning = false;
    translationPaused = false;
    renderProgress(activeJobRecord.textDone || 0, activeJobRecord.textTotal || 0, activeJobRecord.imageDone || 0, activeJobRecord.imageTotal || 0);
    const failures = failedTranslationItems.length;
    const workerWarnings = Array.isArray(message.warnings) ? message.warnings : (Array.isArray(activeJobRecord.warnings) ? activeJobRecord.warnings : []);
    const explicitCancellation = cancellationRequested || message.job?.error === '用户取消了翻译';
    cancellationRequested = false;
    setNotice(message.cancelled
      ? (explicitCancellation
        ? '翻译已取消，已完成内容保留。再次点击“全文翻译”可以继续。'
        : '翻译已暂停。再次点击全文翻译会从本地缓存继续。')
      : failures ? `翻译完成，但有 ${failures} 项需要重试。${workerWarnings.length ? `\n${workerWarnings.slice(0, 3).join('\n')}` : ''}`
        : workerWarnings.length ? `全文翻译完成。${workerWarnings.slice(0, 3).join('\n')}` : '全文翻译完成。可以滚动阅读，或选择一段文字继续追问。');
    saveLocalSession();
  }
  if (message.type === 'deep-research:selection' && message.context) {
    const previousAnchor = selectionContext?.selection;
    const nextAnchor = message.context.selection;
    const sameSelection = Boolean(
      previousAnchor?.quote
      && nextAnchor?.quote
      && previousAnchor.quote === nextAnchor.quote
      && selectionContext?.url === message.context.url
      && (!previousAnchor.contentHash || !nextAnchor.contentHash || previousAnchor.contentHash === nextAnchor.contentHash),
    );
    if (!sameSelection) {
      interactionGeneration += 1;
      discussionController?.abort();
      discussionRunning = false;
      latestAnswer = '';
      latestStructuredAnswer = null;
      discussionHistory = [];
      discussionIntent = 'explain';
      discussionOpen = false;
    }
    imageContext = null;
    selectionContext = message.context;
    discussionScope = 'selection';
    renderPage();
    saveLocalSession();
  }
  if (message.type === 'deep-research:image-action' && message.image) {
    discussionController?.abort();
    selectionContext = null;
    imageContext = { ...(documentContext || pageContext || {}), image: message.image, restored: false };
    latestAnswer = '';
    latestStructuredAnswer = null;
    discussionHistory = [];
    discussionScope = 'image';
    discussionIntent = 'explain';
    discussionOpen = true;
    renderPage();
    saveLocalSession();
    show($('discussion-section'), discussionOpen);
    renderDiscussionContext('image', 'explain', imageContext || pageContext);
  }
  if (message.type === 'deep-research:selection-action') {
    if (message.action === 'translate' && selectionContext) {
      if (!providerReady(provider)) { showSettings(); setNotice('先配置模型后再翻译。'); return; }
      translationRequested = true;
      fullTranslationEnabled = false;
      translationRunning = true;
      activeTranslationRun += 1;
      activeJobRecord = { id: `translation-${crypto.randomUUID()}`, documentUrl: contextUrl(), contentHash: selectionContext?.contentHash || selectionContext?.selection?.contentHash || null, kind: 'text', status: 'queued', textDone: 0, textTotal: 1, imageDone: 0, imageTotal: 0 };
      persistJobPatch(activeJobRecord, { status: 'queued' });
      translationController?.abort();
      translationController = new AbortController();
      renderProgress(0, 1, 0, 0);
      void processDocument({ ...selectionContext, blocks: [{ id: 'selection', text: selectionContext.selection?.quote || '' }], images: [] }, activeTranslationRun);
    }
    if (message.action === 'explain') void explainOrAsk('', 'selection', 'explain');
    if (message.action === 'summary') void explainOrAsk('', 'selection', 'selection-summary');
    if (message.action === 'ask') openDiscussion('selection', 'ask');
    if (message.action === 'save') void saveInsight();
    if (message.action === 'annotate') void openAnnotationDialog();
  }
  if (message.type === 'deep-research:page-action') {
    const pendingWrite = chrome.storage.session?.remove?.('readerPendingPageAction');
    pendingWrite?.catch?.(() => {});
    void handlePageAction(message.action);
  }
  if (message.type === 'deep-research:translations-restored') {
    // A content mutation can invalidate the page version while the user is
    // still in full-translation mode. Preserve that intent and take a fresh
    // snapshot only after the old wrappers are gone. An explicit user restore
    // clears `fullTranslationEnabled` before sending this message, so it
    // still behaves as a true stop action.
    const resumeFullTranslation = Boolean(
      fullTranslationEnabled
      && translationRequested
      && !translationPaused
      && providerReady(provider)
      && pageContext?.url,
    );
    activeTranslationRun += 1;
    translationController?.abort();
    translatedTextIds.clear();
    translatedImageIds.clear();
    translationRunning = resumeFullTranslation;
    if (resumeFullTranslation) {
      translationController = new AbortController();
      setNotice('页面内容已更新，正在继续翻译新增正文和图片…');
      void sendToPage({ type: 'deep-research:request-full-document' });
    } else {
      translationRequested = false;
      fullTranslationEnabled = false;
      translationPaused = false;
      setNotice('已恢复原文。');
    }
    renderProgress();
  }
  if (message.type === 'deep-research:anchor-unresolved') {
    setNotice(message.reason || '原文已变化，无法准确定位；没有跳转到相似段落。');
  }
  if (message.type === 'deep-research:anchor-resolved') {
    setNotice('已回到原文证据。');
  }
  if (message.type === 'deep-research:annotation-unresolved') {
    setNotice(message.reason || '原文已变化，标注没有错误高亮。');
  }
});

async function init() {
  provider = await loadProvider();
  await loadTargetLanguage();
  readingMode = await readerStore.getSetting('readingMode', 'local');
  applyProviderFields();
  await loadPlatformState();
  updateReadingModeUi();
  renderEmptyState();
  $('settings-button').addEventListener('click', showSettings); $('empty-settings').addEventListener('click', handleEmptyPrimary); $('empty-history')?.addEventListener('click', () => void openHistoryPage()); $('open-history-header')?.addEventListener('click', () => void openHistoryPage()); $('close-settings').addEventListener('click', showReading);
  $('mode-local')?.addEventListener('click', () => void setReadingMode('local'));
  $('mode-platform')?.addEventListener('click', () => void setReadingMode('platform'));
  $('provider-kind')?.addEventListener('change', () => updateProviderForm());
  $('translation-language')?.addEventListener('change', async (event) => {
    targetLanguage = event.target.value;
    await readerStore.setSetting('targetLanguage', targetLanguage);
  });
  $('save-settings').addEventListener('click', () => void saveSettings()); $('translate-all').addEventListener('click', () => void startFullTranslation()); $('quick-summary')?.addEventListener('click', () => void explainOrAsk('', 'page', 'summary')); $('quick-map')?.addEventListener('click', () => void explainOrAsk('', 'page', 'map')); $('quick-mechanism')?.addEventListener('click', () => void explainOrAsk('', 'page', 'architecture')); $('quick-tradeoffs')?.addEventListener('click', () => void explainOrAsk('', 'page', 'tradeoffs')); $('pause-translation').addEventListener('click', () => { translationPaused = true; cancellationRequested = false; if (activeJobRecord?.id) chrome.runtime.sendMessage({ type: 'deep-research:translation-cancel', jobId: activeJobRecord.id }).catch(() => {}); translationController?.abort(); renderProgress(); }); $('cancel-translation').addEventListener('click', cancelCurrentTranslation);
  $('restore-page').addEventListener('click', () => { activeTranslationRun += 1; cancellationRequested = false; if (activeJobRecord?.id) chrome.runtime.sendMessage({ type: 'deep-research:translation-cancel', jobId: activeJobRecord.id }).catch(() => {}); persistJobPatch(activeJobRecord, { status: 'cancelled', error: '用户恢复了原文' }); translationController?.abort(); translationRequested = false; fullTranslationEnabled = false; translationPaused = false; translationRunning = false; sendToPage({ type: 'deep-research:restore-translations' }); });
  $('summarize-selection')?.addEventListener('click', () => void explainOrAsk('', 'selection', 'selection-summary'));
  $('explain-selection').addEventListener('click', () => void explainOrAsk('', 'selection', 'explain'));
  $('translate-selection')?.addEventListener('click', () => void explainOrAsk('', 'selection', 'translate'));
  $('ask-selection').addEventListener('click', () => openDiscussion('selection', 'ask'));
  $('ask-page').addEventListener('click', () => {
    if (!documentContext && !pageContext) {
      setNotice('当前页面正文还没有提取完成。');
      return;
    }
    openDiscussion('page', 'ask');
  });
  $('annotate-selection').addEventListener('click', () => void openAnnotationDialog());
  $('save-selection').addEventListener('click', () => void saveInsight());
  $('save-answer')?.addEventListener('click', () => void openSaveDialog());
  $('return-answer')?.addEventListener('click', returnLatestAnswerToSource);
  $('open-chat')?.addEventListener('click', () => openDiscussion('page', 'ask'));
  $('open-page-chat')?.addEventListener('click', () => openDiscussion('page', 'ask'));
  $('open-history-inline')?.addEventListener('click', () => void openHistoryPage());
  $('scope-page')?.addEventListener('click', () => setDiscussionScope('page'));
  $('scope-selection')?.addEventListener('click', () => setDiscussionScope('selection'));
  $('scope-image')?.addEventListener('click', () => setDiscussionScope('image'));
  $('explain-image').addEventListener('click', () => void explainOrAsk('', 'image', 'explain'));
  $('ask-image').addEventListener('click', () => openDiscussion('image', 'ask'));
  $('clear-image').addEventListener('click', () => {
    imageContext = null;
    if (discussionScope === 'image') {
      discussionScope = 'page';
      discussionIntent = 'ask';
      latestAnswer = '';
      latestStructuredAnswer = null;
      discussionHistory = [];
      renderStructuredAnswer(null);
    }
    renderPage();
    saveLocalSession();
  });
  $('sync-selection')?.addEventListener('click', () => void syncInsight()); $('connect-platform')?.addEventListener('click', () => void connectPlatform()); $('disconnect-platform')?.addEventListener('click', () => void disconnectPlatform());
  $('sync-session')?.addEventListener('click', () => void syncCurrentSession()); $('restore-session')?.addEventListener('click', () => void restoreCloudSession());
  $('open-history')?.addEventListener('click', () => void openHistoryPage());
  $('send-question').addEventListener('click', () => {
    const question = $('question-input').value.trim();
    if (question) void explainOrAsk(question, activeDiscussionScope(), 'ask');
  });
  $('copy-answer')?.addEventListener('click', () => void copyAnswer());
  $('continue-answer')?.addEventListener('click', () => {
    $('question-input')?.focus();
    $('question-input')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('continue-saved-discussion')?.addEventListener('click', () => {
    openDiscussion(activeDiscussionScope(), 'ask');
  });
  $('refresh-library').addEventListener('click', () => void updateLibrary());
  $('clear-cache').addEventListener('click', () => void readerStore.clearCache().then(() => setNotice('翻译缓存已清除。', $('settings-notice')))); $('clear-data').addEventListener('click', async () => { if (!window.confirm('清除本地阅读会话、收藏、设置和缓存？导出数据不会受影响。')) return; activeTranslationRun += 1; discussionController?.abort(); translationController?.abort(); translationRunning = false; translationRequested = false; fullTranslationEnabled = false; activeJobRecord = null; pendingJob = null; lastSavedInsight = null; await readerStore.clearAll(); await chrome.storage.local.remove(['readerToken', 'readerPlatformUrl']); provider = null; platformUrl = 'http://localhost:3000'; setPlatformConnected(false); await loadTargetLanguage(); applyProviderFields(); setNotice('本地阅读数据已清除。', $('settings-notice')); await updateLibrary(); }); $('export-data').addEventListener('click', () => void readerStore.exportData().then(downloadJson)); $('import-data').addEventListener('click', () => $('import-file').click()); $('import-file').addEventListener('change', async (event) => { const file = event.target.files?.[0]; if (!file) return; try { await readerStore.importData(JSON.parse(await file.text())); provider = await loadProvider(); await loadTargetLanguage(); if ($('platform-url')) { platformUrl = await readerStore.getSetting('platformUrl', 'http://localhost:3000'); $('platform-url').value = platformUrl; } applyProviderFields(); setNotice('阅读数据已导入。', $('settings-notice')); await updateLibrary(); } catch (error) { setNotice(error instanceof Error ? error.message : '导入失败', $('settings-notice')); } });
  await updateLibrary();
  void restorePendingPageAction();
  // The content script can report page context before React finishes loading
  // this controller. Re-request the active tab after all listeners are bound
  // so opening or recreating the side panel never leaves it blank.
  void activateCurrentPage();
  document.documentElement.dataset.readerReady = 'true';
}

void init();
