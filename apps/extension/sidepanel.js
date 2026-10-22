import { SEARCH_ORIGINS } from './web-search.js';
import { renderMaterialConversation, renderMaterialEvidence, renderMaterialRecords, renderMaterialOptions, renderMaterialFollowups, renderMaterialFailures } from './components/material-runtime.tsx';
import { t, localizedMarkup, getUiLanguage, setUiLanguage } from './i18n.js';
import { platformAnswerErrorMessage } from './platform-answer.js';
import { answerTaskPresentation, waitForAnswerTask, requestAnswerTask } from './answer-task.js';
import { normalizeTranslationLanguage, resolveTranslationLanguage } from './translation-language.js';
import { readerStore } from './reader-store.js';
import {
  prepareVisionImage,
  applyTextTranslations,
  discoverModels,
  isLocalProvider,
  translationContext,
  translationBatches,
  explainSelection,
  readingAnswerText,
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
  combineTranslationParts,
  splitTranslationBlocks,
  testVisionProvider,
  translateBlocks,
  translateImage,
} from './reader-core.js';
import { renderMarkdown, streamingAnswerText } from './markdown-renderer.js';
import { ModelConnectionError, modelConnectionError, normalizeModelBaseUrl, validateModelConnection } from './model-connection.js';
import { findProvider, matchingProviders } from './provider-catalog.js';
import {
  DEFAULT_WEB_APP_URL,
  LEGACY_LOCAL_WEB_APP_URL,
  normalizePlatformOrigin,
  resolvePlatformOrigin,
  trustedPlatformHint,
  tokenBoundToOrigin,
} from './platform-config.js';

const $ = (id) => document.getElementById(id);
let provider = null;
let translationLanguage = 'interface';
let pageContext = null;
let documentContext = null;
let selectionContext = null;
let imageContext = null;
let latestAnswer = '';
let latestStructuredAnswer = null;
let latestAnswerContext = null;
let discussionHistory = [];
let discussionScope = 'page';
let discussionIntent = 'ask';
let discussionOpen = false;
let pendingAnswer = null;
let pendingPageAction = null;
let discussionController = null;
let discussionSubscription = null;
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
let platformUrl = DEFAULT_WEB_APP_URL;
let platformConnected = false;
let readingMode = 'local';
let webSearchEnabled = false;
function renderWebSearchToggle() {
  $('web-search-toggle')?.setAttribute('aria-pressed', String(webSearchEnabled));
  if ($('web-search-state')) $('web-search-state').textContent = webSearchEnabled ? t('按需搜索') : /最新|现在|还在维护|替代|比较|核实|latest|current|maintain|alternative|compar|verify/iu.test($('question-input')?.value || '') ? t('可联网核实最新信息') : t('已关闭');
}
async function syncSearchPermissions() {
  if (readingMode === 'platform' || !webSearchEnabled) return;
  if (await chrome.permissions.contains({ origins: SEARCH_ORIGINS })) return;
  webSearchEnabled = false;
  renderWebSearchToggle();
  await readerStore.setSetting('webSearchEnabled', false);
  setNotice(t('独立模式需要搜索站点权限，请重新开启联网补充以授权。'));
}
function answerProgressText(done, total, phase) {
  const statuses = { 'search-planning': t('正在判断是否需要搜索…'), searching: t('正在搜索网络来源…'), 'search-complete': t('正在结合原文生成回答…'), 'search-unavailable': t('搜索暂不可用，继续依据原文回答…') };
  return statuses[phase] || (phase === 'merging' ? t('原文已读取，正在整合依据…') : t('正在核对原文依据（{0}/{1}）…', done, total));
}
let sessionSyncTimer = 0;
let radarEntryPlatformUrl = '';
let radarEntryPromptKey = '';
let radarEntrySummaryId = '';
let radarEntryUrl = '';
let platformDisconnecting = false;
let pageKnowledgeKey = '';
let pageKnowledgeRequest = 0;
let pageKnowledgeController = null;
// `init()` loads the persisted token asynchronously.  A callback can finish
// the PKCE exchange during that window; an older `loadPlatformState()` result
// must not overwrite the newer connection event and hide the sync controls.
let platformStateEvents = 0;
const windowSourceTab = Number(new URLSearchParams(location.search).get('sourceTab'));
const boundWindowTabId = windowSourceTab > 0 && Number.isInteger(windowSourceTab) ? windowSourceTab : null;
let activeTabId = boundWindowTabId;
let activationNeeded = null;
let pageReadState = 'idle';
let lastSavedInsight = null;
let insightSyncFailed = false;
let editingInsight = null;
let pendingInsightSource = null;
let editingAnnotation = null;
let pendingAnnotationHighlightId = null;
let activeSessionTitle = '';
let sessionSaveQueue = Promise.resolve();
const translatedTextIds = new Set();
const translatedImageIds = new Set();
const resumedUrls = new Set();
const sessionResumeTasks = new Map();
const questionDrafts = new Map();
try { for (const [url, draft] of JSON.parse(sessionStorage.getItem('readerQuestionDrafts') || '[]')) questionDrafts.set(url, draft); } catch { /* Draft persistence is optional. */ }
let draftPageUrl = '';
let fitComposerInput = () => {};
let composerModelCache = null;
let composerModelController = null;
function sameModelConnection(a, b) { return Boolean(a && b && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey && a.providerKind === b.providerKind); }
function closeComposerModelMenu({ restoreFocus = false } = {}) {
  composerModelController?.abort();
  show($('composer-model-menu'), false);
  $('composer-model')?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('composer-model')?.focus();
}
function renderComposerModelOptions() {
  const search = $('composer-model-search').value.trim().toLocaleLowerCase();
  const models = new Map([[provider.model, { id: provider.model, label: provider.model }]]);
  if (sameModelConnection(composerModelCache?.connection, provider)) for (const item of composerModelCache.models) models.set(item.id, item);
  const options = [...models.values()].filter(item => `${item.label} ${item.id}`.toLocaleLowerCase().includes(search));
  renderMaterialOptions($('composer-model-options'), options, provider.model, model => void chooseComposerModel(model));
  $('composer-model-status').textContent = options.length ? t("切换用于下一次提问；当前回答继续使用原模型。") : t("没有匹配的模型。");
}
async function refreshComposerModels() {
  if (readingMode !== 'local' || !providerReady(provider)) return;
  composerModelController?.abort();
  const controller = new AbortController(); composerModelController = controller;
  const connection = { ...provider };
  $('composer-model-status').textContent = t("正在读取模型列表…");
  try {
    const models = await discoverModels(connection, { signal: controller.signal });
    if (controller.signal.aborted || !sameModelConnection(connection, provider) || readingMode !== 'local') return;
    composerModelCache = { connection, models, fetchedAt: Date.now() };
    renderComposerModelOptions();
    $('composer-model-status').textContent = t("切换用于下一次提问；当前回答继续使用原模型。");
  } catch (error) {
    if (controller.signal.aborted) return;
    $('composer-model-status').textContent = t("{0}。可继续使用当前模型，或打开连接设置。", error.message || '模型列表暂不可用');
  }
}
async function chooseComposerModel(model) {
  if (readingMode !== 'local' || !providerReady(provider)) return;
  try {
    if (model !== provider.model) provider = await saveProvider({ ...provider, model, visionReady: false });
    closeComposerModelMenu();
    applyProviderFields(); renderPersistentComposer();
    $('question-input')?.focus();
  } catch (error) { $('composer-model-status').textContent = error.message || t("模型切换失败，请重试。"); }
}
function toggleComposerModelMenu() {
  if (readingMode !== 'local') return;
  if (!providerReady(provider)) { showSettings(); return; }
  if (!$('composer-model-menu').classList.contains('hidden')) { closeComposerModelMenu({ restoreFocus: true }); return; }
  $('composer-model-search').value = '';
  renderComposerModelOptions();
  show($('composer-model-menu'), true); $('composer-model').setAttribute('aria-expanded', 'true');
  $('composer-model-search').focus();
  if (!sameModelConnection(composerModelCache?.connection, provider) || Date.now() - composerModelCache.fetchedAt > 60_000) void refreshComposerModels();
  else $('composer-model-status').textContent = t("切换用于下一次提问；当前回答继续使用原模型。");
}
function switchQuestionDraft(url = '') {
  if (url === draftPageUrl) return;
  const input = $('question-input');
  if (input && draftPageUrl) questionDrafts.set(draftPageUrl, input.value);
  draftPageUrl = url;
  if (input) input.value = questionDrafts.get(url) || '';
}
function persistQuestionDraft() {
  if (draftPageUrl) questionDrafts.set(draftPageUrl, $('question-input')?.value || '');
  try { sessionStorage.setItem('readerQuestionDrafts', JSON.stringify([...questionDrafts].slice(-50))); } catch { /* Full or unavailable storage must not block chat. */ }
  updateSendAvailability();
}

function detachCurrentAnswer() {
  discussionSubscription?.abort();
  discussionSubscription = null;
  discussionController = null;
  discussionRunning = false;
  pendingAnswer = null;
  renderPendingAnswer();
}

function updateSendAvailability() {
  renderProgress();
  const send = $('send-question');
  if (!send) return;
  send.disabled = send.dataset.contextReady !== 'true' || !$('question-input')?.value.trim() || discussionRunning;
}
let sessionGeneration = 0;
let interactionGeneration = 0;
const DISCUSSION_INTENTS = new Set(['explain', 'ask', 'summary', 'selection-summary', 'translate', 'map', 'architecture', 'tradeoffs']);

function sendToPage(payload, tabId = boundWindowTabId || activeTabId) {
  return chrome.runtime.sendMessage({ type: 'deep-research:to-page', payload, ...(tabId ? { tabId } : {}) }).catch(() => ({ ok: false }));
}

function focusReadingAnchor(anchor) {
  // The article stays in its original tab; keep the conversation and draft visible.
  sendToPage(anchor?.quote
    ? { type: 'deep-research:focus-anchor', anchor }
    : { type: 'deep-research:focus-page' });
}

function setWorkspaceView(view) {
  const shell = document.querySelector('.shell');
  if (view === 'tools') view = 'chat';
  if (!shell || !['chat', 'library'].includes(view)) return;
  shell.dataset.workspaceView = view;
  // Keep deep links in sync with the visible tab. An old ?view=library must
  // not send a chat back to Saved when changing language or reloading.
  const viewUrl = new URL(location.href);
  if (view === 'chat') viewUrl.searchParams.delete('view');
  else viewUrl.searchParams.set('view', view);
  if (viewUrl.href !== location.href) window.history.replaceState(null, '', viewUrl.href);
  for (const name of ['chat', 'tools', 'library']) {
    const button = $(`nav-${name}`);
    button?.classList.toggle('active', name === view);
    button?.setAttribute('aria-pressed', String(name === view));
  }
}

function setupWorkspaceLayout() {
  // Text fields match :focus-visible after mouse clicks too. Track keyboard
  // navigation so only a deliberate keyboard focus gets an outer composer ring.
  document.addEventListener('pointerdown', () => document.documentElement.classList.remove('keyboard-navigation'), true);
  document.addEventListener('keydown', event => { if (event.key === 'Tab') document.documentElement.classList.add('keyboard-navigation'); }, true);
  $('chat-to-reading')?.addEventListener('click', () => focusReadingAnchor(activeDiscussionScope() === 'selection' ? selectionContext?.selection : null));
  $('chat-translate-all')?.addEventListener('click', () => { focusReadingAnchor(null); void startFullTranslation(); });
  $('copy-chat-selection')?.addEventListener('click', () => void copyCurrentSelection());
  $('clear-chat-selection')?.addEventListener('click', () => { selectionContext = null; discussionScope = 'page'; discussionIntent = 'ask'; sendToPage({ type: 'deep-research:clear-native-selection' }); renderPage(); saveLocalSession(); });
  $('toggle-chat-selection')?.addEventListener('click', () => {
    const expanded = !$('chat-selection-card').classList.contains('expanded');
    $('chat-selection-card').classList.toggle('expanded', expanded);
    $('toggle-chat-selection').setAttribute('aria-expanded', String(expanded));
    $('toggle-chat-selection').textContent = expanded ? t("收起") : t("展开");
  });
  document.addEventListener('pointerdown', event => {
    if (!$('composer-model-menu')?.contains(event.target) && !$('composer-model')?.contains(event.target)) closeComposerModelMenu();
  });
  $('composer-model-search')?.addEventListener('input', renderComposerModelOptions);
  $('composer-model-refresh')?.addEventListener('click', () => void refreshComposerModels());
  $('composer-model-settings')?.addEventListener('click', () => { closeComposerModelMenu(); showSettings(); });
  $('composer-model-menu')?.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeComposerModelMenu({ restoreFocus: true }); return; }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    if (event.target === $('composer-model-search') && event.key !== 'ArrowDown') return;
    const options = [...$('composer-model-options').querySelectorAll('button')];
    if (!options.length) return;
    event.preventDefault(); const current = options.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowUp' ? (current <= 0 ? options.length - 1 : current - 1) : (current + 1) % options.length;
    options[index].focus();
  });
  $('dismiss-notice')?.addEventListener('click', () => setNotice(''));
  for (const view of ['chat', 'tools', 'library']) {
    $(`nav-${view}`)?.addEventListener('click', () => {
      showReading();
      setChatExpanded(false);
      setWorkspaceView(view);
      if (view === 'chat') openDiscussion(activeDiscussionScope(), 'ask');
    });
  }
  const handle = $('composer-resize');
  const input = $('question-input');
  if (!handle || !input) return;
  let preferredHeight = 60;
  let manuallySized = false;
  const maxInputHeight = () => {
    const limit = Math.min(240, window.innerHeight * 0.4);
    const composer = $('persistent-composer');
    const area = composer?.parentElement;
    if (!composer?.getClientRects().length || !area?.clientHeight) return Math.max(60, limit);
    const overhead = Math.max(0, composer.getBoundingClientRect().height - input.getBoundingClientRect().height);
    const style = getComputedStyle(composer);
    const margin = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    // Leave a readable transcript and keep Send inside the panel even when
    // selection/image context consumes part of the composer.
    return Math.max(60, Math.min(limit, area.clientHeight - overhead - margin - 60));
  };
  const updateSizeControl = height => {
    const toggle = $('composer-size-toggle');
    if (toggle) {
      toggle.disabled = maxInputHeight() <= 60;
      toggle.title = toggle.disabled ? t('窗口空间不足，请先增大浏览器高度') : t('展开或收起输入框');
      toggle.setAttribute('aria-expanded', String(height > 61));
      toggle.setAttribute('aria-label', height > 61 ? t('收起输入框') : t('展开输入框'));
    }
    handle.setAttribute('aria-valuemax', String(Math.floor(maxInputHeight())));
  };
  const resize = (height) => {
    const bounded = Math.round(Math.max(60, Math.min(maxInputHeight(), height)));
    preferredHeight = bounded;
    manuallySized = true;
    input.style.height = `${bounded}px`;
    handle.setAttribute('aria-valuenow', String(bounded));
    updateSizeControl(bounded);
    try { localStorage.setItem('readerComposerHeight', String(bounded)); } catch { /* Optional preference. */ }
  };
  try { const saved = Number(localStorage.getItem('readerComposerHeight')); if (saved) resize(saved); } catch { /* Default height remains usable. */ }
  fitComposerInput = () => {
    if (!input.getClientRects().length) return;
    const baseline = Math.max(60, Math.min(preferredHeight, maxInputHeight()));
    input.style.height = `${baseline}px`;
    const height = manuallySized ? baseline : Math.max(baseline, Math.min(maxInputHeight(), input.scrollHeight));
    input.style.height = `${Math.round(height)}px`;
    handle.setAttribute('aria-valuenow', String(Math.round(height)));
    updateSizeControl(height);
  };
  $('composer-size-toggle')?.addEventListener('click', () => resize(input.getBoundingClientRect().height > 61 ? 60 : 240));
  input.addEventListener('input', fitComposerInput);
  window.addEventListener('resize', fitComposerInput);
  $('composer-model')?.addEventListener('click', toggleComposerModelMenu);
  $('starter-summary')?.addEventListener('click', () => $('chat-summary')?.click());
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = input.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    const move = (next) => resize(startHeight + startY - next.clientY);
    const stop = () => { handle.removeEventListener('pointermove', move); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop, { once: true });
    handle.addEventListener('pointercancel', stop, { once: true });
  });
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    resize(event.key === 'Home' ? 60 : event.key === 'End' ? 240 : input.getBoundingClientRect().height + (event.key === 'ArrowUp' ? 16 : -16));
  });
}

function show(el, visible = true) {
  if (!el) return;
  el.classList.toggle('hidden', !visible);
  if (el.id === 'discussion-section') {
    $('page-view')?.classList.toggle('has-discussion', visible);
    if (!visible) setChatExpanded(false);
  }
}

function setChatExpanded(expanded) {
  $('page-view')?.classList.toggle('chat-expanded', expanded);
  const button = $('expand-chat');
  if (button) {
    button.textContent = expanded ? t("恢复布局") : t("放大聊天");
    button.setAttribute('aria-pressed', String(expanded));
  }
}

async function copyCurrentSelection() {
  const quote = selectionContext?.selection?.quote;
  if (activeDiscussionScope() !== 'selection' || !quote) return;
  try {
    await navigator.clipboard.writeText(quote);
    const button = $('copy-chat-selection');
    if (button) {
      button.textContent = t("已复制");
      window.setTimeout(() => { button.textContent = t("复制选段"); }, 1800);
    }
  } catch {
    setNotice(t("浏览器没有开放剪贴板权限，请在原网页选择原文复制。"));
  }
}

function setNotice(message = '', target = $('notice')) {
  if (target.dataset) delete target.dataset.result;
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
    return { state: 'error', label: t("当前页面不支持"), detail: t("Chrome 保护页、扩展商店等页面不能注入阅读助手。") };
  }
  if (activationNeeded?.reason === 'permission') {
    return { state: 'idle', label: t("尚未启用此站点"), detail: t("点击“启用此站点”后，Reader 才会读取正文。") };
  }
  if (!context) {
    return { state: pageReadState === 'error' ? 'error' : 'loading', label: t("正在读取正文"), detail: t("正在提取标题、章节和可用正文。") };
  }
  if (!contextHasReadableBody(context)) {
    return { state: 'error', label: t("没有可用正文"), detail: t("没有提取到可用于问答的正文；可以重新加载页面或选择一段原文。") };
  }
  const blocks = Number(context.blockCount || context.blocks?.length || 0);
  const chars = Number(context.bodyCharCount || String(context.body || '').length || 0);
  const bounded = context.bodyTruncated || context.blocksTruncated;
  const details = [t("{0} 个正文块", blocks), t("{0} 字符", chars.toLocaleString())];
  if (bounded) details.push(t("已按上下文上限截取"));
  return { state: 'ready', label: t("正文已读取"), detail: details.join(' · ') };
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
  sendToPage({
    type: 'deep-research:reader-status',
    state: descriptor.state,
    label: descriptor.label,
    detail: descriptor.detail,
  });
}

function renderPersistentComposer(scope = activeDiscussionScope()) {
  updateTranslationLanguageUi();
  const context = activeDiscussionContext(scope);
  const composer = $('persistent-composer');
  if (!composer) return;
  const visible = Boolean(document.querySelector('.shell')?.dataset.workspaceView === 'chat' || discussionOpen || discussionHistory.length || latestAnswer || latestStructuredAnswer);
  show(composer, visible);
  const descriptor = pageReadDescriptor(context);
  const selectionReady = scope === 'selection' && Boolean(context?.selection?.quote);
  show($('copy-chat-selection'), selectionReady);
  show($('chat-selection-card'), selectionReady);
  show($('selection-section'), selectionReady);
  show($('image-section'), scope === 'image' && Boolean(imageContext?.image));
  show($('chat-summary'), scope !== 'image');
  show($('chat-translate'), scope !== 'image');
  const selectionQuote = $('chat-selection-quote');
  if (selectionQuote && selectionQuote.textContent !== (context?.selection?.quote || '')) {
    selectionQuote.textContent = context?.selection?.quote || '';
    $('chat-selection-card').classList.remove('expanded');
    $('toggle-chat-selection').setAttribute('aria-expanded', 'false');
    $('toggle-chat-selection').textContent = t("展开");
  }
  const pageReady = scope !== 'page' || contextHasReadableBody(context);
  const canSend = scope === 'page'
    ? contextHasReadableBody(context)
    : scope === 'selection'
      ? Boolean(pageReady && selectionReady)
      : Boolean(imageContext?.image && pageReady);
  if ($('composer-scope-label')) $('composer-scope-label').textContent = discussionScopeLabel(scope);
  if ($('composer-context-status')) $('composer-context-status').textContent = t("正文状态：{0}", descriptor.label);
  const question = $('question-input');
  if (question) {
    question.placeholder = scope === 'selection'
      ? t("问问这段内容…")
      : scope === 'image'
        ? t("问问这张图…")
        : t("问问这篇文章…");
  }
  fitComposerInput();
  const model = $('composer-model');
  if (model) {
    model.disabled = readingMode === 'platform';
    $('composer-model-label').textContent = readingMode === 'platform' ? t("平台模型") : (provider?.model || t("配置模型"));
    model.title = readingMode === 'platform' ? t("由平台配置固定模型") : t("独立模式 · {0} · 点击切换模型", provider?.model || '未配置');
    if (readingMode === 'platform') { closeComposerModelMenu(); model.removeAttribute('aria-haspopup'); }
    else model.setAttribute('aria-haspopup', 'dialog');
  }
  const send = $('send-question');
  if (send) {
    send.dataset.contextReady = String(canSend);
    updateSendAvailability();
    show($('stop-answer'), discussionRunning);
    show(send, !discussionRunning);
    if ($('answer-task-status')) $('answer-task-status').textContent = discussionRunning ? t("回答进行中 · 可继续阅读") : '';
    send.title = canSend ? t("使用上方显示的范围发送问题") : descriptor.detail;
  }
}

function platformModeReady() {
  return readingMode === 'platform' && platformConnected;
}

function textModelReady() {
  return readingMode === 'platform' ? platformConnected : providerReady(provider);
}

function updateAiAvailabilityBanner() {
  const banner = $('ai-availability-banner');
  const message = $('ai-availability-message');
  const action = $('ai-availability-action');
  if (!banner || !message || !action) return;
  const hasReadableContext = contextHasReadableBody(pageContext || documentContext)
    || Boolean(selectionContext?.selection?.quote)
    || Boolean(imageContext?.image);
  const ready = textModelReady();
  show(banner, hasReadableContext && !ready);
  if (!hasReadableContext || ready) return;
  const platform = readingMode === 'platform';
  message.textContent = platform
    ? t("平台模式尚未连接，问答、总结和翻译暂不可用。")
    : t("独立模式尚未配置模型，问答、总结和翻译暂不可用。");
  action.textContent = platform ? t("连接平台") : t("配置模型");
}

function updateReadingModeUi() {
  const platform = readingMode === 'platform';
  $('mode-local')?.setAttribute('aria-pressed', String(!platform));
  $('mode-platform')?.setAttribute('aria-pressed', String(platform));
  $('storage-status')?.classList.toggle('platform', platform);
  if ($('storage-status')) $('storage-status').textContent = platform ? t("平台模式") : t("独立模式");
  show($('platform-settings'), platform);
  show($('local-provider-settings'), !platform);
  if ($('platform-inline-status')) {
    $('platform-inline-status').textContent = platform
      ? platformConnected ? t("会话与结论同步到调研平台") : t("平台模式尚未连接")
      : t("成果保存在浏览器本地");
  }
  if ($('platform-inline-description')) {
    $('platform-inline-description').textContent = platform
      ? platformConnected
        ? t("问答、总结和全文翻译使用平台 AI Engine；图片在你发起图示问答或翻译时由浏览器读取字节并发送给视觉模型。")
        : t("连接调研平台后即可使用平台 AI Engine，无需配置本地模型。")
      : t("会话和阅读成果保存在浏览器；需要同步到研究库时可切换平台模式。");
  }
  if ($('sync-selection')) $('sync-selection').textContent = t("重试同步");
  show($('sync-selection'), platform && platformConnected && Boolean(lastSavedInsight) && insightSyncFailed);
  show($('sync-session'), platform && platformConnected && Boolean(contextUrl()));
  show($('restore-session'), platform && platformConnected);
  if ($('mode-data-note')) {
    $('mode-data-note').textContent = platform
      ? platformConnected
        ? t("平台模式：文本操作使用调研平台 AI Engine；发起图示问答或翻译时，图片字节会按需发送给视觉模型，不会保存到平台阅读库。")
        : t("平台模式尚未连接：连接并登录后使用调研平台 AI Engine；当前不会调用本地模型。")
      : t("独立模式：模型请求、聊天记录和阅读成果保存在本地，可导出或清除。");
  }
  const guidance = $('mode-guidance');
  if (guidance) {
    guidance.classList.remove('is-warning', 'is-connected');
    if (platform && platformConnected) {
      guidance.textContent = t("平台模式已连接。问答、总结、全文翻译和图片文字翻译使用调研平台 AI Engine；图片仅在你发起图示问答或翻译时由浏览器读取并上传字节，不会让服务器抓取图片地址。");
      guidance.classList.add('is-connected');
      show(guidance, true);
    } else if (platform) {
      guidance.textContent = t("平台模式尚未连接。点击下方“连接平台”并完成登录；无需填写本地模型服务。");
      guidance.classList.add('is-warning');
      show(guidance, true);
    } else if (!providerReady(provider)) {
      guidance.textContent = t("选择服务并连接，模型列表会自动读取；本地代理的 API Key 可留空。");
      guidance.classList.add('is-warning');
      show(guidance, true);
    } else {
      show(guidance, false);
    }
  }
  if (platform) setStatus(platformConnected, platformConnected ? t("平台 AI 已连接") : t("平台未连接"));
  else setStatus(providerReady(provider), providerReady(provider) ? t("{0} 已配置", provider.model) : t("未配置模型"));
  updateAiAvailabilityBanner();
}

async function setReadingMode(mode) {
  readingMode = mode === 'platform' ? 'platform' : 'local';
  await syncSearchPermissions();
  updateReadingModeUi();
  renderEmptyState();
  if (readingMode === 'platform' && !platformConnected) showSettings();
  try {
    await readerStore.setSetting('readingMode', readingMode);
  } catch {
    setNotice(t("运行模式已切换，但未能保存设置；重新打开侧栏后可能恢复之前的模式。"), $('settings-notice'));
  }
}

function currentReadingLanguage() {
  return getUiLanguage();
}

function currentTranslationLanguage() {
  return resolveTranslationLanguage(translationLanguage, getUiLanguage());
}

function updateTranslationLanguageUi() {
  window.dispatchEvent(new CustomEvent('reader:translation-language-state', { detail: {
    value: translationLanguage, disabled: translationRunning || Boolean(retryingTranslationId), visible: activeDiscussionScope() !== 'image',
  } }));
}

async function changeTranslationLanguage(value) {
  if (translationRunning || retryingTranslationId) return;
  const next = normalizeTranslationLanguage(value);
  try {
    await readerStore.setSetting('translationLanguage', next);
    translationLanguage = next;
    // Existing translations remain readable until the next explicit translation.
    // Stop automatic continuation in the old language after a page mutation.
    fullTranslationEnabled = false;
    translationRequested = false;
    pendingJob = null;
    updateTranslationLanguageUi();
  } catch {
    setNotice(t("翻译语言未能保存，请重试。"));
  }
}

function readingProvider(language = currentTranslationLanguage()) {
  return provider ? { ...provider, language } : provider;
}

function providerPreset(kind) {
  return PROVIDER_PRESETS[kind] || PROVIDER_PRESETS.custom;
}

function streamAnswerPreview(value) {
  return streamingAnswerText(value);
}

function bindCitationReferences(container, evidenceItems) {
  container?.querySelectorAll('[data-reader-citation]').forEach((reference) => {
    const index = Number(reference.dataset.readerCitation) - 1;
    const item = evidenceItems[index];
    if (!item) {
      reference.replaceWith(document.createTextNode(reference.textContent || ''));
      return;
    }
    reference.href = item.url || contextUrl() || '#';
    reference.removeAttribute('target');
    reference.title = item.anchor?.quote ? t("跳转到对应原文证据") : t("打开原文");
    reference.addEventListener('click', (event) => {
      if (!item.anchor?.quote) return;
      event.preventDefault();
      focusReadingAnchor(item.anchor);
    });
  });
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
  const evidenceItems = Array.isArray(answer.evidence) ? answer.evidence : [];
  const answerOutput = $('answer-output');
  renderMarkdown(answerOutput, readingAnswerText(answer.answer || latestAnswer));
  bindCitationReferences(answerOutput, evidenceItems);
  const evidenceLabel = evidencePart?.querySelector('.response-section-label');
  if (evidenceLabel) evidenceLabel.textContent = evidenceItems.length ? t("原文证据 · {0}", evidenceItems.length) : t("原文证据");
  renderMaterialEvidence(evidenceList, evidenceItems.map((item, index) => ({
    id: `reader-evidence-${index + 1}`, claim: item.claim, quote: item.quote,
    url: item.url || contextUrl(), anchored: Boolean(item.anchor?.quote),
    onLocate: item.anchor?.quote ? () => focusReadingAnchor(item.anchor) : undefined,
  })));
  show(evidencePart, evidenceList.childElementCount > 0);
  renderMarkdown($('answer-background-text'), answer.background || '');
  bindCitationReferences($('answer-background-text'), evidenceItems);
  show(backgroundPart, Boolean(answer.background));
  renderMarkdown($('answer-inference-text'), answer.inference || '');
  bindCitationReferences($('answer-inference-text'), evidenceItems);
  show(inferencePart, Boolean(answer.inference));
  const limitationList = $('answer-limitations-list');
  limitationList.textContent = '';
    (Array.isArray(answer.limitations) ? answer.limitations : []).forEach((item) => {
      const li = document.createElement('li');
      renderMarkdown(li, item);
      bindCitationReferences(li, evidenceItems);
      limitationList.appendChild(li);
    });
  show(limitationsPart, limitationList.childElementCount > 0);
  const moreParts = [answer.background && t("背景"), answer.inference && t("推断"), limitationList.childElementCount && t("未知项")].filter(Boolean);
  $('answer-more-summary').textContent = moreParts.join(' · ');
  show($('answer-more'), moreParts.length > 0);
  const warningText = Array.isArray(answer.warnings)
    ? [...new Set(answer.warnings.filter(Boolean).map((warning) => t(warning)))].join('\n')
    : '';
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
  if (answer.searchStatus === 'unavailable') lines.push('', t('联网搜索暂不可用，本次依据原文回答，未核实最新网络信息。'));
  if (answer.webSources?.length) lines.push('', t('网络来源 · 搜索摘要'), ...answer.webSources.map((item, i) => `[W${i + 1}] ${item.title} ${item.url}`));
  const evidence = Array.isArray(answer.evidence) ? answer.evidence : [];
  if (evidence.length) {
    lines.push('', t("原文证据"));
    evidence.forEach((item, index) => {
      const quote = String(item?.quote || '').trim();
      const claim = String(item?.claim || '').trim();
      if (quote) lines.push(`[${index + 1}] ${quote}${claim ? `：${claim}` : ''}`);
    });
  }
  if (answer.inference) lines.push('', t("AI 推断：{0}", answer.inference));
  return lines.join('\n').trim();
}

async function copyAnswer() {
  const text = answerClipboardText();
  if (!text) {
    setNotice(t("当前还没有可复制的回答。"));
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setNotice(t("回答和原文证据已复制。"));
  } catch {
    setNotice(t("浏览器没有开放剪贴板权限，请手动选择回答复制。"));
  }
}

async function submitReadingForm(buttonId, noticeId, submit) {
  const button = $(buttonId);
  if (!button || button.disabled) return;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = t("保存中…");
  button.setAttribute('aria-busy', 'true');
  try { await submit(); }
  catch (error) { setNotice(error instanceof Error ? error.message : t("保存失败，请重试。"), $(noticeId)); }
  finally {
    button.disabled = false;
    button.textContent = label;
    button.removeAttribute('aria-busy');
  }
}

function ensureSaveDialog() {
  let section = $('save-dialog');
  const bindActions = (dialog) => {
    if (!dialog || dialog.dataset.readerActionsBound === 'true') return dialog;
    dialog.dataset.readerActionsBound = 'true';
    dialog.querySelector('#confirm-save')?.addEventListener('click', () => void submitReadingForm('confirm-save', 'save-notice', confirmSaveInsight));
    dialog.querySelector('#cancel-save')?.addEventListener('click', () => { editingInsight = null; pendingInsightSource = null; showReading(); });
    return dialog;
  };
  return bindActions(section);
}

function ensureAnnotationDialog() {
  let section = $('annotation-dialog');
  const bindActions = (dialog) => {
    if (!dialog || dialog.dataset.readerActionsBound === 'true') return dialog;
    dialog.dataset.readerActionsBound = 'true';
    dialog.querySelector('#confirm-annotation')?.addEventListener('click', () => void submitReadingForm('confirm-annotation', 'annotation-notice', confirmAnnotation));
    dialog.querySelector('#cancel-annotation')?.addEventListener('click', () => { editingAnnotation = null; showReading(); });
    return dialog;
  };
  return bindActions(section);
}

function contextUrl() { return documentContext?.url || pageContext?.url || selectionContext?.url || ''; }

function normalizeRadarSummaryId(value) {
  return readerStore.normalizeRadarSummaryId(value);
}

function currentRadarSummaryId(url = contextUrl()) {
  const key = readerStore.knowledgePageKey(url);
  return key && key === radarEntryUrl ? normalizeRadarSummaryId(radarEntrySummaryId) : '';
}

function applyRadarEntryContext(context) {
  if (context?.entrySource !== 'radar') {
    if (radarEntryUrl && readerStore.knowledgePageKey(context?.url) === radarEntryUrl) return;
    radarEntryPlatformUrl = '';
    radarEntryPromptKey = '';
    radarEntrySummaryId = '';
    radarEntryUrl = '';
    return;
  }
  const hintedOrigin = trustedPlatformHint(context.entryPlatformUrl, platformUrl);
  const summaryId = normalizeRadarSummaryId(context.entrySummaryId);
  if (hintedOrigin) radarEntryPlatformUrl = hintedOrigin;
  radarEntrySummaryId = summaryId;
  radarEntryUrl = readerStore.knowledgePageKey(context.url);

  const configuredOrigin = normalizePlatformOrigin(platformUrl);
  const canUseHint = !configuredOrigin
    || configuredOrigin === LEGACY_LOCAL_WEB_APP_URL
    || configuredOrigin === DEFAULT_WEB_APP_URL;
  // Never retarget a connected platform from page-controlled input; the hint
  // only applies while no token exists, and is never persisted here.
  if (hintedOrigin && canUseHint && !platformConnected) {
    platformUrl = hintedOrigin;
    updatePlatformTarget();
  }

  const promptKey = `${summaryId}:${hintedOrigin}`;
  if (!promptKey || promptKey === ':') return;
  if (promptKey === radarEntryPromptKey || platformConnected) return;
  radarEntryPromptKey = promptKey;
  setNotice(t("这篇内容来自调研平台雷达；连接后可同步会话和确认保存的结论。"));
}

function persistJobPatch(job, patch) {
  if (!job?.id) return;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  void readerStore.saveJob(job);
}

function translationCoverageWarning(context) {
  if (!context?.bodyTruncated && !context?.blocksTruncated) return '';
  const totalBlocks = Number(context.blockCount || context.blocks?.length || 0);
  const processedBlocks = Array.isArray(context.blocks) ? context.blocks.length : 0;
  const totalChars = Number(context.bodyCharCount || String(context.body || '').length || 0);
  const processedChars = String(context.body || '').length;
  const details = [];
  if (context.blocksTruncated) details.push(t("正文块 {0} / {1}", processedBlocks.toLocaleString(), totalBlocks.toLocaleString()));
  if (context.bodyTruncated) details.push(t("字符 {0} / {1}", processedChars.toLocaleString(), totalChars.toLocaleString()));
  return t("本页超出当前处理上限（{0}）；未覆盖内容没有翻译。", details.join('，'));
}

function saveLocalSession() {
  if (!contextUrl()) return;
  const pageVersion = documentContext?.contentHash || pageContext?.contentHash || selectionContext?.contentHash || null;
  const snapshot = {
    url: contextUrl(),
    title: activeSessionTitle || documentContext?.title || pageContext?.title || selectionContext?.title || t("未命名页面"),
    titleEdited: Boolean(activeSessionTitle && activeSessionTitle !== (documentContext?.title || pageContext?.title || selectionContext?.title || '')),
    version: pageVersion,
    stale: false,
    selection: selectionContext?.selection || null,
    answer: latestAnswer,
    answerStructured: latestStructuredAnswer,
    discussion: discussionHistory,
    discussionScope,
    discussionIntent,
    radarSummaryId: currentRadarSummaryId() || null,
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
    const session = pending || await readerStore.getReadingSession(context.url, version);
    if (!session || generation !== sessionGeneration || interaction !== interactionGeneration
      || readerStore.pageKey(context.url) !== readerStore.pageKey(contextUrl())) return;
    const restoredRadarSummaryId = normalizeRadarSummaryId(session.radarSummaryId);
    if (!currentRadarSummaryId(context.url) && restoredRadarSummaryId) {
      radarEntrySummaryId = restoredRadarSummaryId;
      radarEntryUrl = readerStore.knowledgePageKey(context.url);
    }
    const preserveSelection = Boolean(selectionContext?.selection?.quote && selectionContext.url === context.url);
    const restoredSelection = session.stale ? null : session.selection || null;
    activeSessionTitle = session.titleEdited ? (session.title || context.title || '') : '';
    if (Number(session.scrollY) > 0 || session.selection?.quote || session.image?.id || session.answer || session.discussion?.length) {
      latestAnswer = session.answer || '';
      latestStructuredAnswer = session.answerStructured || null;
      if (session.stale && latestStructuredAnswer) latestStructuredAnswer = { ...latestStructuredAnswer, evidence: [], warnings: [...(latestStructuredAnswer.warnings || []), t("页面内容已更新，旧引文定位已撤销。")] };
      latestAnswerContext = session.answer || session.answerStructured
        ? { ...context, radarSummaryId: restoredRadarSummaryId || undefined, scope: session.stale ? 'page' : session.discussionScope || 'page', selection: restoredSelection }
        : null;
      discussionHistory = Array.isArray(session.discussion) ? session.discussion : [];
      discussionOpen = Boolean(
        session.answer
        || session.answerStructured
        || session.discussion?.length,
      );
      if (!preserveSelection) discussionIntent = DISCUSSION_INTENTS.has(session.discussionIntent)
        ? session.discussionIntent
        : session.discussion?.some((item) => item?.role === 'user') ? 'ask' : 'explain';
      if (restoredSelection?.quote && !preserveSelection) {
        selectionContext = { ...context, scope: 'selection', selection: restoredSelection };
      }
      if (!preserveSelection) discussionScope = !session.stale && ['selection', 'page', 'image'].includes(session.discussionScope)
        ? session.discussionScope
        : 'page';
      if (session.image?.id) imageContext = { ...context, image: session.image, restored: true };
      renderPage();
      if (!preserveSelection) sendToPage({ type: 'deep-research:restore-progress', scrollY: session.scrollY, anchor: restoredSelection });
      if (!session.stale && session.pendingEvidenceAnchor?.quote) {
        sendToPage({ type: 'deep-research:focus-anchor', anchor: session.pendingEvidenceAnchor });
      }
      if (session.stale) setNotice(t("已恢复历史会话；当前原文版本不同，旧证据请重新核对后再继续。"));
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
    title: pending.title || context.title || t("未命名页面"),
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
    const section = context?.sectionTitle || t("所在小节");
    return t("当前选段 · {0} 字符 · {1}", quoteLength.toLocaleString(), section);
  }
  if (scope === 'image') return t("当前图示与页面正文");
  const blocks = Number(context?.blockCount || context?.blocks?.length || 0);
  const chars = Number(context?.bodyCharCount || String(context?.body || '').length || 0);
  const bounded = context?.bodyTruncated || context?.blocksTruncated;
  const parts = [t("整页正文")];
  if (blocks) parts.push(t("{0} 个正文块", blocks));
  if (chars) parts.push(t("{0} 字符", chars.toLocaleString()));
  if (bounded) parts.push(t("已按上下文上限截取"));
  return parts.join(' · ');
}

function discussionIntentLabel(intent = discussionIntent) {
  if (intent === 'summary') return t("全文总结");
  if (intent === 'selection-summary') return t("选段总结");
  if (intent === 'translate') return t("翻译");
  if (intent === 'map') return t("文章地图");
  if (intent === 'architecture') return t("关键机制");
  if (intent === 'tradeoffs') return t("风险与取舍");
  if (intent === 'ask') return t("提问");
  return t("解读");
}

function discussionScopeLabel(scope = discussionScope) {
  if (scope === 'page') return t("整页正文");
  if (scope === 'image') return t("当前图示");
  return t("当前选段");
}

function discussionLabel(scope = discussionScope, intent = discussionIntent) {
  return `${discussionScopeLabel(scope)} · ${discussionIntentLabel(intent)}`;
}

function renderDiscussionScopeControls(scope = discussionScope) {
  const selectionAvailable = Boolean(selectionContext?.selection?.quote);
  const imageAvailable = Boolean(imageContext?.image);
  const hasAlternative = selectionAvailable || imageAvailable;
  const options = [
    ['scope-page', 'page'],
    ['scope-selection', 'selection'],
    ['scope-image', 'image'],
  ];
  options.forEach(([id, optionScope]) => {
    const button = $(id);
    if (!button) return;
    const available = optionScope === 'page'
      ? hasAlternative
      : optionScope === 'selection'
        ? selectionAvailable
        : imageAvailable;
    show(button, available);
    button.setAttribute('aria-pressed', String(scope === optionScope));
    button.classList.toggle('active', scope === optionScope);
  });
  show($('discussion-scope-options'), hasAlternative);
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
  if ($('discussion-source-title')) { $('discussion-source-title').textContent = source?.title || pageContext?.title || t("当前页面"); $('discussion-source-title').title = `${source?.title || t("当前页面")}\n${source?.url || ''}`; }
  if ($('discussion-source-url')) $('discussion-source-url').textContent = source?.url || pageContext?.url || '';
  if (detail) {
    detail.textContent = formatCoverage(source, scope);
  }
  renderDiscussionScopeControls(scope);
  if ($('chat-scope-description')) $('chat-scope-description').textContent = scope === 'selection' ? t("基于当前选段") : scope === 'image' ? t("基于当前图示") : t("基于整篇文章");
  updatePageContextUi(source || pageContext || documentContext);
  renderPersistentComposer(scope);
}

function suggestedFollowups(scope = activeDiscussionScope(), intent = discussionIntent) {
  if (scope === 'selection') {
    if (intent === 'translate') return [t("这段中的技术术语分别是什么意思？"), t("把这段改写成实现步骤。"), t("这段内容有哪些隐含前提？")];
    if (intent === 'selection-summary') return [t("这段结论依赖哪些原文证据？"), t("这段和文章主线是什么关系？"), t("这段有没有可能的反例？")];
    return [t("这段代码或机制的关键约束是什么？"), t("能用一个具体例子说明吗？"), t("这段方案的替代做法是什么？")];
  }
  if (scope === 'image') return [t("图中的数据流瓶颈在哪里？"), t("哪些组件关系可以从图中直接确认？"), t("这张图对应的实现风险是什么？")];
  if (intent === 'summary') return [t("作者的核心假设是什么？"), t("哪些结论需要结合其他资料核对？"), t("这套方案与常见做法相比改变了什么？")];
  if (intent === 'map') return [t("先解释最关键的一条依赖链。"), t("哪一章最值得优先阅读？"), t("文章的主线是否存在跳步？")];
  if (intent === 'architecture') return [t("哪些组件是不可替代的？"), t("如果规模扩大，最先遇到什么瓶颈？"), t("请把架构转成实现检查清单。")];
  if (intent === 'tradeoffs') return [t("哪些取舍是文章明确说出的？"), t("有哪些失败条件没有被验证？"), t("请给出一个反例或替代方案。")];
  return [t("用一个具体例子说明刚才的结论。"), t("这篇文章有哪些隐含前提？"), t("请把回答压缩成实现检查清单。")];
}

function renderDiscussionFollowups(scope = activeDiscussionScope(), intent = discussionIntent) {
  const section = $('discussion-followups');
  const list = $('discussion-followup-list');
  if (!section || !list) return;
  const prompts = latestStructuredAnswer && !discussionRunning ? suggestedFollowups(scope, intent) : [];
  renderMaterialFollowups(list, prompts, prompt => { if (!discussionRunning) void explainOrAsk(prompt, scope, 'ask'); });
  show(section, prompts.length > 0);
}

function renderConversation() {
  const list = $('conversation-list');
  if (!list) return;
  const messages = discussionHistory.filter(item => item && ['user', 'assistant'].includes(item.role) && String(item.content || '').trim());
  renderMaterialConversation(list, messages, {
    copy: true,
    bindLatest: element => bindCitationReferences(element, Array.isArray(latestStructuredAnswer?.evidence) ? latestStructuredAnswer.evidence : []),
    onCopyError: () => setNotice(t("浏览器没有开放剪贴板权限，请手动选择回答复制。")),
  });
  show(list, messages.length > 0);
  show($('conversation-empty'), messages.length === 0 && !discussionRunning);
}

function renderEmptyState() {
  const title = $('empty-title');
  const description = $('empty-description');
  const primary = $('empty-settings');
  if (!title || !description || !primary) return;
  if (!textModelReady()) {
    title.textContent = readingMode === 'platform' ? t("平台模式尚未连接。") : t("独立模式尚未配置模型。");
    description.textContent = readingMode === 'platform'
      ? t("连接并登录调研平台后，问答与全文翻译即可使用平台 AI Engine。")
      : t("配置本地模型，或在设置中切换到平台模式并连接调研平台。");
    primary.textContent = readingMode === 'platform' ? t("连接调研平台") : t("配置独立模型");
    primary.disabled = false;
    show(primary, true);
    return;
  }
  if (activationNeeded?.reason === 'unsupported') {
    title.textContent = t("当前页面不支持阅读。");
    description.textContent = t("Chrome 内置页、扩展商店和其他受保护页面不允许注入阅读助手。请切换到公开文章、文档或 GitHub 页面。");
    show(primary, false);
    return;
  }
  if (activationNeeded?.reason === 'unknown') {
    title.textContent = t("暂时无法确认当前网页。");
    description.textContent = t("请切回普通网页，或点击浏览器工具栏中的 Deep Research Reader 图标后重试。");
    primary.textContent = t("重新检查当前页");
    primary.disabled = false;
    show(primary, true);
    return;
  }
  if (activationNeeded?.reason === 'permission') {
    title.textContent = t("启用当前网页，开始阅读。");
    description.textContent = t("只会为这个站点申请访问权限。点击后才读取当前页面，之后在本窗口切换网页会再次询问。");
    primary.textContent = t("启用此站点");
    primary.disabled = false;
    show(primary, true);
    return;
  }
  title.textContent = t("开始阅读当前网页。");
  description.textContent = t("点击下方按钮只启用当前页；全文翻译、选段解读和讨论都从原网页开始。");
  primary.textContent = t("开始阅读当前页");
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
  if ($('saved-insight-title')) $('saved-insight-title').textContent = t("已保存阅读结论");
  if ($('saved-insight-detail')) {
    $('saved-insight-detail').textContent = lastSavedInsight.quote
      ? t("已保存摘录和结论：{0}{1}", String(lastSavedInsight.quote).slice(0, 72), String(lastSavedInsight.quote).length > 72 ? '…' : '')
      : t("可以回到当前会话继续讨论。");
  }
}

function latestAnswerSource() {
  const context = latestAnswerContext || activeDiscussionContext(activeDiscussionScope()) || documentContext || pageContext || selectionContext;
  if (!context?.url) return null;
  const radarSummaryId = latestAnswerContext
    ? normalizeRadarSummaryId(latestAnswerContext.radarSummaryId) || undefined
    : currentRadarSummaryId(context.url) || undefined;
  const answer = latestStructuredAnswer && typeof latestStructuredAnswer === 'object'
    ? latestStructuredAnswer
    : null;
  const evidence = Array.isArray(answer?.evidence)
    ? answer.evidence.find((item) => item?.quote && item?.anchor?.quote
      && (!item.url || readerStore.pageKey(item.url) === readerStore.pageKey(context.url)))
    : null;
  if (evidence) {
    const version = context.contentHash || context.version || evidence.anchor.contentHash || null;
    return {
      title: context.title || t("未命名页面"),
      url: context.url,
      radarSummaryId,
      document: { url: context.url, title: context.title || t("未命名页面"), version },
      quote: String(evidence.quote).trim(),
      anchor: evidence.anchor,
      note: '',
      aiAnswer: latestAnswer,
      tags: [],
    };
  }
  const scope = latestAnswerContext?.scope || activeDiscussionScope();
  const selection = scope === 'selection'
    ? (context.selection?.quote ? context.selection : selectionContext?.selection)
    : null;
  if (selection?.quote && (latestAnswerContext || !selectionContext?.url || selectionContext.url === context.url)) {
    const version = context.contentHash || context.version || selection.contentHash || null;
    return {
      title: context.title || selectionContext?.title || t("未命名页面"),
      url: context.url,
      radarSummaryId,
      document: { url: context.url, title: context.title || selectionContext?.title || t("未命名页面"), version },
      quote: selection.quote,
      anchor: selection,
      note: '',
      aiAnswer: latestAnswer,
      tags: [],
    };
  }
  const body = String(context.body || '').trim();
  if (!body) return null;
  return {
    title: context.title || t("未命名页面"),
    url: context.url,
    radarSummaryId,
    document: { url: context.url, title: context.title || t("未命名页面"), version: context.contentHash || context.version || null },
    quote: body.slice(0, 600),
    note: '',
    aiAnswer: latestAnswer,
    tags: [],
    fallbackWarning: t("当前回答没有可精确定位的原文证据；这里只能保存页面开头的无锚点摘录，请确认后再保存。"),
  };
}

function renderPage() {
  void updatePageKnowledge();
  if (['settings-view', 'save-dialog', 'annotation-dialog'].some((id) => {
    const view = $(id);
    return view && !view.classList.contains('hidden');
  })) return;
  const context = pageContext || documentContext || selectionContext;
  show($('empty-view'), !context);
  show($('page-view'), Boolean(context));
  updateAiAvailabilityBanner();
  if (!context) {
    show($('discussion-section'), false);
    show($('persistent-composer'), false);
    renderEmptyState();
    return;
  }
  $('page-title').textContent = context.title || t("未命名页面");
  $('page-source').textContent = context.url || '';
  updatePageContextUi(context);
  const scopeNotice = $('scope-notice');
  const scopeWarnings = Array.isArray(context.scopeWarnings) ? context.scopeWarnings.filter(Boolean) : [];
  if (context.entrySource === 'radar') {
    scopeWarnings.unshift(t("来自 Deep Research 雷达。连接和同步仍需你的明确操作。"));
  }
  if (scopeNotice) {
    scopeNotice.textContent = scopeWarnings.join('\n');
    show($('scope-details'), scopeWarnings.length > 0);
    show(scopeNotice, scopeWarnings.length > 0);
  }
  if (context.translationDetected && !translationRequested) {
    setNotice(t("检测到页面可能已有其他翻译插件。开启 Deep Research Reader 前请确认是否继续，避免重复插入译文。"));
  }
  if (imageContext?.image) {
    const image = imageContext.image;
    $('image-preview-title').textContent = image.alt || t("当前图示");
    const thumbnail = $('image-preview-thumbnail');
    const previewUrl = image.dataUrl || image.src || '';
    if (thumbnail) { thumbnail.src = /^(https?:\/\/|data:image\/)/u.test(previewUrl) ? previewUrl : ''; show(thumbnail, Boolean(thumbnail.getAttribute('src'))); }
    $('image-preview-meta').textContent = readingMode === 'platform'
      ? t("平台视觉模型结合当前图示和正文回答；图片仅在你提问时发送。")
      : imageContext.restored
        ? t("已恢复图示讨论上下文；如需继续追问，请在原网页重新点击该图示。")
        : t("{0} × {1} · 图片内容只按需发送给视觉模型", image.width || '?', image.height || '?');
    show($('explain-image'), true);
  }
  const visibleDiscussionScope = activeDiscussionScope();
  // Keep the page action surface compact until the user chooses a discussion
  // action. Once opened, the same section becomes a persistent transcript and
  // composer, so the user can continue the conversation without losing scope.
  const discussionVisible = Boolean(
    document.querySelector('.shell')?.dataset.workspaceView === 'chat'
    || (boundWindowTabId && document.querySelector('.shell')?.dataset.workspaceView === 'tools')
    || discussionOpen
    || discussionHistory.length
    || latestAnswer
    || latestStructuredAnswer,
  );
  show($('discussion-section'), discussionVisible);
  renderDiscussionContext(visibleDiscussionScope, discussionIntent, activeDiscussionContext(visibleDiscussionScope));
  renderConversation();
  show($('answer-output'), discussionRunning && Boolean(pendingAnswer?.streamedText));
  renderStructuredAnswer(latestStructuredAnswer);
  renderDiscussionFollowups(visibleDiscussionScope, discussionIntent);
  renderPersistentComposer(visibleDiscussionScope);
  renderPendingAnswer();
  renderSavedInsightBanner();
}

function renderProgress(textDone = activeJobRecord?.textDone || 0, textTotal = activeJobRecord?.textTotal || 0, imageDone = activeJobRecord?.imageDone || 0, imageTotal = activeJobRecord?.imageTotal || 0) {
  updateTranslationLanguageUi();
  const skippedTextCount = activeJobRecord?.skippedTextIds?.length || 0;
  const displayTotal = Math.max(0, textTotal - skippedTextCount);
  const displayDone = Math.min(displayTotal, Array.isArray(activeJobRecord?.appliedTextIds)
    ? activeJobRecord.appliedTextIds.length : (pageContext?.translatedBlockIds?.length || 0));
  const displayIncomplete = activeJobRecord?.status !== 'cancelled' && !translationRunning && displayTotal > 0 && displayDone < displayTotal;
  const needsRetry = !translationRunning && !translationPaused && failedTranslationItems.length > 0;
  const hasTranslations = Boolean(translatedTextIds.size || translatedImageIds.size || pageContext?.translatedBlockIds?.length || pageContext?.translatedImageIds?.length || ((translationRequested || fullTranslationEnabled) && (textDone || imageDone)));
  const failed = !translationRunning && !translationPaused && (activeJobRecord?.status === 'failed' || displayIncomplete);
  const visible = translationRunning || translationPaused || needsRetry || hasTranslations || failed;
  const task = $('translation-summary');
  const previousState = task.dataset.state;
  show(task, visible);
  task.dataset.state = needsRetry || failed ? 'error' : translationPaused ? 'paused' : translationRunning ? 'progress' : 'completed';
  $('translation-summary-text').textContent = translationPaused ? t("翻译已暂停，已完成内容保留")
    : translationRunning ? (textTotal || imageTotal ? t("正在翻译 · {0}/{1} 段{2}", displayDone, displayTotal, imageTotal ? ` · ${t("{0} / {1} 张图片", imageDone, imageTotal)}` : '') : t("正在读取网页…"))
      : needsRetry ? t("{0} 项翻译需要重试", failedTranslationItems.length)
        : failed ? t("翻译未完成，可重试")
          : activeJobRecord?.status === 'cancelled' ? t("翻译已取消，已完成内容保留")
            : t("本页已有译文");
  const details = $('translation-details');
  if (!visible) details.open = false;
  else if ((needsRetry || failed) && previousState !== 'error') details.open = true;
  show($('progress-area'), Boolean(textTotal || imageTotal || translationRunning || failedTranslationItems.length));
  const textPercent = displayTotal ? Math.round((displayDone / displayTotal) * 100) : 0;
  const imagePercent = imageTotal ? Math.round((imageDone / imageTotal) * 100) : 0;
  $('text-progress-value').textContent = `${displayDone} / ${displayTotal}`;
  $('text-progress-value').title = skippedTextCount ? t("已显示 {0} 段译文；{1} 个代码块保留原文，不计入翻译完成数。", displayDone, skippedTextCount) : t("已在原网页显示的译文数量");
  $('text-progress-track').setAttribute('aria-valuenow', String(textPercent));
  $('text-progress-track').setAttribute('aria-valuetext', displayTotal ? t("{0} / {1} 个正文片段", displayDone, displayTotal) : t("尚未开始"));
  $('text-progress-bar').style.width = `${textPercent}%`;
  $('image-progress-value').textContent = imageTotal ? `${imageDone} / ${imageTotal}` : t("无可读取图片");
  $('image-progress-value').title = imageTotal && readingMode === 'platform'
    ? t("图片文字翻译由调研平台视觉能力处理；图片只在本次操作中按需上传，不会保存到平台阅读库。")
    : '';
  $('image-progress-track').setAttribute('aria-valuenow', String(imagePercent));
  $('image-progress-track').setAttribute('aria-valuetext', imageTotal ? t("{0} / {1} 张图片", imageDone, imageTotal) : t("无可读取图片"));
  $('image-progress-bar').style.width = `${imagePercent}%`;
  $('progress-area').setAttribute('aria-busy', String(translationRunning));
  $('chat-translate').disabled = translationRunning && activeDiscussionScope() !== 'selection';
  $('pause-translation').textContent = translationPaused && translationRunning ? t("正在暂停…") : translationPaused ? t("继续") : failed ? t("重试") : t("暂停");
  $('pause-translation').disabled = translationPaused && translationRunning;
  show($('pause-translation'), translationRunning || translationPaused || failed);
  show($('cancel-translation'), translationRunning || translationPaused);
  show($('restore-page'), hasTranslations);
  renderTranslationFailures();
}

function renderTranslationFailures() {
  const section = $('translation-failures');
  if (!section) return;
  renderMaterialFailures(section, failedTranslationItems, retryingTranslationId, item => void retryTranslationItem(item), id => {
    sendToPage({ type: 'deep-research:mark-static-frame', imageId: id });
    setNotice(t("已标记当前帧；正在重新读取图片，随后可重试翻译。"));
  });
  show(section, failedTranslationItems.length > 0);
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
  void updatePageKnowledge({ refresh: true });
  const [insights, annotations] = await Promise.all([
    readerStore.listInsights(),
    readerStore.listAnnotations(),
  ]);
  const list = $('library-list');
  const historyButton = $('open-history');
  if (historyButton) historyButton.textContent = t("聊天记录");
  const records = [
    ...insights.slice(0, 12).map(insight => ({ key: insight.id, className: 'insight-row', title: insight.title || insight.quote,
      detail: insight.quote, tags: insight.tags, meta: new Date(insight.createdAt).toLocaleString(), actions: [
        { label: t("编辑"), action: 'edit', run: () => openSaveDialog(insight) },
        { label: t("删除"), action: 'delete', danger: true, run: async () => { await readerStore.deleteInsight(insight.id); await updateLibrary(); } },
      ] })),
    ...annotations.slice(0, 12).map(annotation => ({ key: annotation.id, className: 'insight-row annotation-row',
      title: annotation.note || annotation.document?.title || t("未命名标注"), detail: annotation.anchor?.quote,
      meta: t("标注 · {0}", new Date(annotation.updatedAt || annotation.createdAt).toLocaleString()), actions: [
        { label: t("回到原文"), action: 'focus', run: async () => { try { await chrome.tabs.create({ url: buildAnnotationUrl(annotation.document.url, annotation.anchor), active: true }); } catch { setNotice(t("无法打开原文，请复制来源地址后重试。")); } } },
        { label: t("删除"), action: 'delete', danger: true, run: async () => { await readerStore.deleteAnnotation(annotation.id); if (readerStore.pageKey(contextUrl()) === readerStore.pageKey(annotation.document.url)) sendToPage({ type: 'deep-research:clear-annotations' }); await updateLibrary(); } },
      ] })),
  ];
  renderMaterialRecords(list, records, t("还没有收藏。点击选段旁的“保存摘录”或回答下方的“保存结论”，确认后才会加入这里。聊天记录自动保存在“历史”中。"));
}

async function openKnowledgeUrl(value) {
  if (!readerStore.knowledgePageKey(value)) return;
  try { await chrome.tabs.create({ url: value, active: true }); }
  catch { setNotice(t("无法打开原文，请复制来源地址后重试。")); }
}

function renderPageKnowledge(items) {
  const host = $('page-knowledge-list');
  if (!host) return;
  const wasVisible = !$('page-knowledge')?.classList.contains('hidden');
  renderMaterialRecords(host, items.map(item => {
    const text = String(item.note || item.aiAnswer || item.quote || item.anchor?.quote || '').trim();
    const date = new Date(item.updatedAt || item.createdAt || '');
    const source = item.kind === 'platform' ? t("研究库") : item.kind === 'annotation' ? t("标注") : t("本地收藏");
    const researchUrl = platformConnected && item.platformResearchId
      ? `${platformUrl}/researches/${encodeURIComponent(item.platformResearchId)}` : '';
    return {
      key: `${item.kind}:${item.id}`, title: item.title || item.document?.title || source,
      detail: text.slice(0, 240) + (text.length > 240 ? '…' : ''),
      meta: [source, Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()].filter(Boolean).join(' · '),
      status: item.stale ? t("旧版本") : undefined,
      warning: item.stale,
      actions: [
        { label: t("原文 ↗"), action: 'source', run: () => void openKnowledgeUrl(item.url || item.document?.url) },
        ...(researchUrl ? [{ label: t("研究库"), action: 'research', run: () => {
          if (platformConnected && item.platformOrigin === normalizePlatformOrigin(platformUrl)) void openKnowledgeUrl(researchUrl);
        } }] : []),
        ...(item.kind === 'insight' ? [{ label: t("编辑"), action: 'edit', run: async () => {
          const insight = await readerStore.getInsight(item.id);
          if (insight) openSaveDialog(insight);
        } }] : []),
      ],
    };
  }));
  show($('page-knowledge'), items.length > 0);
  if (items.length && !wasVisible && $('page-knowledge-disclosure')) $('page-knowledge-disclosure').open = true;
}

async function updatePageKnowledge({ refresh = false } = {}) {
  const url = contextUrl();
  const version = documentContext?.contentHash || pageContext?.contentHash || selectionContext?.contentHash || null;
  const origin = platformConnected && !platformDisconnecting ? normalizePlatformOrigin(platformUrl) : '';
  const events = platformStateEvents;
  const key = JSON.stringify([url, version, origin, events]);
  if (!refresh && key === pageKnowledgeKey) return;
  pageKnowledgeKey = key;
  const request = ++pageKnowledgeRequest;
  pageKnowledgeController?.abort();
  const controller = new AbortController();
  pageKnowledgeController = controller;
  renderPageKnowledge([]);
  if (!readerStore.knowledgePageKey(url)) return;
  const current = () => request === pageKnowledgeRequest && contextUrl() === url
    && events === platformStateEvents && !controller.signal.aborted
    && origin === (platformConnected && !platformDisconnecting ? normalizePlatformOrigin(platformUrl) : '');
  try {
    const local = await readerStore.listPageKnowledge(url, { version, origin });
    if (!current()) return;
    renderPageKnowledge(local);
    if (!origin) return;
    const token = await readPlatformToken();
    if (!token || !current()) return;
    const response = await fetch(`${origin}/api/reading/save?url=${encodeURIComponent(url)}`, {
      headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
    });
    const payload = await response.json().catch(() => ({}));
    if (!current()) return;
    if (response.status === 401 || response.status === 403) {
      setPlatformConnected(false, t("平台令牌已失效，请重新连接"));
      return;
    }
    if (!response.ok) return;
    const items = await readerStore.listPageKnowledge(url, { version, origin, platformItems: payload.items });
    if (current()) renderPageKnowledge(items);
  } catch {
    // Optional recall must not interrupt local reading or expose cached cloud
    // results after a disconnect. Local confirmed records remain available.
  }
}

async function findPendingTranslation(context) {
  if (!context?.url || translationRunning || (pendingJob?.documentUrl === context.url && pendingJob?.targetLanguage === currentTranslationLanguage())) return;
  const jobs = await readerStore.listJobs();
  const version = context.contentHash || context.version || null;
  const sameUrlJobs = jobs.filter((item) => item.documentUrl === context.url);
  // A URL is not a document identity. Keep old jobs visible in local storage,
  // but never resume one whose source hash is different (or missing). Mark it
  // stale so a later panel open cannot mistake it for recoverable work.
  const staleJobs = sameUrlJobs.filter((item) => version && item.status !== 'stale' && item.contentHash !== version);
  await Promise.all(staleJobs.map((item) => readerStore.saveJob({ ...item, status: 'stale', error: t("页面内容已变化，旧翻译任务已失效"), tabId: undefined })));
  if (staleJobs.length) setNotice(t("页面内容已变化，旧的翻译任务、证据和讨论已失效；请重新开始。"));
  const job = sameUrlJobs.find((item) => item.contentHash && version && item.contentHash === version && item.targetLanguage === currentTranslationLanguage());
  if (!job || !['queued', 'running', 'cancelled', 'failed', 'completed', 'completed_with_errors'].includes(job.status)) return;
  pendingJob = { ...job, appliedTextIds: context.translatedBlockIds || [] };
  activeJobRecord = pendingJob;
  failedTranslationItems = Array.isArray(job.failedItems) ? job.failedItems : [];
  renderProgress(job.textDone || 0, job.textTotal || 0, job.imageDone || 0, job.imageTotal || 0);
  const progress = t("已处理 {0}/{1} 个正文块、{2}/{3} 张图片", job.textDone || 0, job.textTotal || 0, job.imageDone || 0, job.imageTotal || 0);
  const statusNotice = job.status === 'completed_with_errors'
    ? t("上次全文翻译完成，但有 {0} 项未完成；可以逐项重试。", failedTranslationItems.length)
    : job.status === 'completed'
      ? t("上次全文翻译已完成：{0}。", progress)
      : job.status === 'cancelled'
        ? t("上次全文翻译已暂停：{0}；点击“全文翻译”可从本地缓存继续。", progress)
        : job.status === 'failed'
          ? t("上次全文翻译中断：{0}；点击“全文翻译”可从本地缓存重试。", progress)
          : t("上次全文翻译尚未结束：{0}；已完成内容会从本地缓存跳过。", progress);
  // Completed progress remains available in Tools; don't replay its success banner on every reopen.
  if (job.status !== 'completed' || failedTranslationItems.length) setNotice(statusNotice);
  // A side-panel document can be destroyed while a request is in flight. A
  // queued/running job is therefore a durable recovery signal. A completed
  // job is only history: translation results are a bounded cache, so opening
  // a page must never silently send fresh model requests after the cache has
  // been cleared. Completed-with-errors, cancelled, and failed jobs remain
  // explicit user retry actions.
  if (textModelReady() && ['queued', 'running'].includes(job.status)) {
    translationRequested = true;
    fullTranslationEnabled = true;
    translationPaused = false;
    translationRunning = true;
    activeTranslationRun += 1;
    translationController?.abort();
    translationController = new AbortController();
    pendingJob = null;
    setNotice(t("正在恢复上次未完成的全文翻译；已完成内容会从本地缓存跳过。"));
    sendToPage({ type: 'deep-research:request-full-document' });
  }
}

function applyProviderFields() {
  const kind = provider?.providerKind || 'openai';
  if (!providerFieldsDirty) {
    $('provider-kind').value = kind;
    providerFormKind = kind;
    $('provider-url').value = provider?.baseUrl || providerPreset(kind).baseUrl || '';
    $('provider-model').value = providerReady(provider) ? provider.model : '';
    $('provider-key').value = provider?.apiKey || '';
    renderSettingsModels(providerReady(provider) ? provider.model : '');
    $('provider-connection-state').textContent = providerReady(provider) ? t("已配置") : t("未连接");
  }
  updateProviderForm();
  if (readingMode === 'platform') setStatus(platformConnected, platformConnected ? t("平台 AI 已连接") : t("平台未连接"));
  else setStatus(providerReady(provider), providerReady(provider) ? t("{0} 已配置", provider.model) : t("未配置模型"));
}

function updateProviderForm() {
  const kind = $('provider-kind')?.value || 'openai';
  const preset = providerPreset(kind);
  show($('provider-custom-url-field'), true);
  renderProviderPickerSelection();
  if ($('provider-model')) $('provider-model').placeholder = preset.placeholder;
  if ($('provider-key-label')) $('provider-key-label').textContent = isLocalProvider({ baseUrl: $('provider-url').value }) ? t("API Key（本地服务选填）") : 'API Key';
  if ($('provider-endpoint-hint')) {
    try {
      const baseUrl = normalizeModelBaseUrl($('provider-url').value, kind);
      $('provider-endpoint-hint').textContent = `${preset.protocol === 'anthropic' ? 'Anthropic' : t("OpenAI 兼容")} · ${baseUrl}`;
    } catch { $('provider-endpoint-hint').textContent = ''; }
  }
}

async function requestOriginPermission(baseUrl) {
  if (!chrome.permissions?.request) return true;
  let origin;
  try { origin = `${new URL(baseUrl).origin}/*`; } catch { throw new Error(t("模型服务地址不是有效 URL")); }
  return chrome.permissions.request({ origins: [origin] });
}

async function requestSpecificOrigin(baseUrl) {
  if (!chrome.permissions?.request) return true;
  let origin;
  try { origin = `${new URL(baseUrl).origin}/*`; } catch { throw new Error(t("平台地址不是有效 URL")); }
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
  if (!connected) window.clearTimeout(sessionSyncTimer);
  if (connected) platformDisconnecting = false;
  void updatePageKnowledge();
  if (!$('platform-status')) return;
  show($('connect-platform'), !connected);
  show($('disconnect-platform'), connected);
  $('platform-status').textContent = message || (connected ? t("已连接 Deep Research") : t("未连接"));
  $('platform-status').classList.toggle('connected', connected);
  if ($('sync-selection')) $('sync-selection').textContent = t("重试同步");
  show($('sync-selection'), connected && Boolean(lastSavedInsight) && insightSyncFailed);
  show($('sync-session'), connected && Boolean(contextUrl()));
  show($('restore-session'), connected);
  updateReadingModeUi();
  renderEmptyState();
}

function updatePlatformTarget() {
  if (!$('platform-target')) return;
  platformUrl = resolvePlatformOrigin(platformUrl, radarEntryPlatformUrl);
  $('platform-target').textContent = new URL(platformUrl).host;
}

async function loadPlatformState() {
  if (!$('platform-status')) return;
  const stateRead = platformStateEvents;
  const [databaseUrl, localState] = await Promise.all([
    readerStore.getSetting('platformUrl', ''),
    chrome.storage.local.get(['readerToken', 'readerPlatformUrl']),
  ]);
  const configuredUrl = databaseUrl || localState.readerPlatformUrl || '';
  platformUrl = resolvePlatformOrigin(configuredUrl, radarEntryPlatformUrl);
  updatePlatformTarget();
  let hasToken = Boolean(localState.readerToken);
  if (normalizePlatformOrigin(configuredUrl) === LEGACY_LOCAL_WEB_APP_URL) {
    await Promise.all([
      readerStore.setSetting('platformUrl', platformUrl),
      chrome.storage.local.set({ readerPlatformUrl: platformUrl }),
    ]);
    if (platformUrl !== LEGACY_LOCAL_WEB_APP_URL && hasToken) {
      await chrome.storage.local.remove('readerToken');
      hasToken = false;
    }
  }
  if (stateRead !== platformStateEvents) return;
  setPlatformConnected(hasToken);
}

async function readPlatformToken(origin = platformUrl) {
  const stored = await chrome.storage.local.get(['readerToken', 'readerTokenOrigin', 'readerPlatformUrl']);
  if (!stored.readerToken) return '';
  const bound = stored.readerTokenOrigin || stored.readerPlatformUrl || '';
  return tokenBoundToOrigin(bound, origin) ? stored.readerToken : '';
}

async function connectPlatform() {
  platformUrl = resolvePlatformOrigin(platformUrl, radarEntryPlatformUrl);
  updatePlatformTarget();
  if (platformUrl !== DEFAULT_WEB_APP_URL
    && !window.confirm(t("将连接到非默认平台 {0}，并把阅读内容和访问令牌发送到该地址。仅在你信任它时继续。", platformUrl))) {
    setPlatformConnected(false, t("已取消连接"));
    return;
  }
  try {
    const granted = await requestSpecificOrigin(platformUrl);
    if (!granted) { setPlatformConnected(false, t("没有获得平台访问权限")); return; }
  } catch (error) {
    setPlatformConnected(false, error instanceof Error ? error.message : t("无法获得平台访问权限"));
    return;
  }

  try {
    const response = await fetch(`${platformUrl}/healthz`, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    setPlatformConnected(false, t("无法连接调研平台（{0}），请检查网络后重试", new URL(platformUrl).host));
    return;
  }

  await Promise.all([
    readerStore.setSetting('platformUrl', platformUrl),
    chrome.storage.local.set({ readerPlatformUrl: platformUrl }),
  ]);
  setPlatformConnected(false, t("正在打开 Deep Research 登录…"));
  try {
    const result = await chrome.runtime.sendMessage({ type: 'deep-research:connect' });
    if (!result?.ok) throw new Error(result?.message || t("无法打开平台授权页"));
  } catch (error) {
    setPlatformConnected(false, error instanceof Error ? error.message : t("无法打开平台授权页"));
  }
}

async function disconnectPlatform() {
  const origin = platformUrl;
  const tokenRead = readPlatformToken(origin);
  platformDisconnecting = true;
  platformStateEvents += 1;
  setPlatformConnected(false, t("已断开平台连接"));
  const readerToken = await tokenRead;
  if (readerToken) {
    try {
      await fetch(`${origin}/api/reading/token/revoke`, { method: 'POST', headers: { authorization: `Bearer ${readerToken}` } });
    } catch {
      // Local disconnect still removes the credential if the platform is down.
    }
  }
  chrome.runtime.sendMessage({ type: 'deep-research:disconnect' }).catch(() => {});
  setPlatformConnected(false, t("已断开平台连接"));
}

async function syncInsight(insight = lastSavedInsight) {
  if (!insight) { setNotice(t("先收藏一个选段，再同步到研究库。")); return; }
  const origin = platformUrl;
  const events = platformStateEvents;
  const connected = () => platformConnected && !platformDisconnecting && platformUrl === origin && platformStateEvents === events;
  const readerToken = await readPlatformToken();
  if (!readerToken || !connected()) {
    insightSyncFailed = true;
    updateReadingModeUi();
    setNotice(t("先在设置中连接 Deep Research，再重试同步。"));
    return;
  }
  insightSyncFailed = false;
  updateReadingModeUi();
  try {
    const request = {
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
        ...(normalizeRadarSummaryId(insight.radarSummaryId) ? { radarSummaryId: normalizeRadarSummaryId(insight.radarSummaryId) } : {}),
      }),
    };
    let response = await fetch(`${origin}/api/reading/save`, request);
    let payload = await response.json().catch(() => ({}));
    if (!connected()) return;
    if (!response.ok) throw new Error(payload.message || t("研究库同步失败"));
    if (payload.deduplicated) {
      response = await fetch(`${origin}/api/reading/save`, { ...request, method: 'PUT' });
      payload = await response.json().catch(() => ({}));
      if (!connected()) return;
      if (!response.ok || !payload.updated) throw new Error(payload.message || t("平台尚不支持更新此收藏；修改已保存在本地，云端尚未更新。"));
    }
    const linked = normalizeRadarSummaryId(payload.draft?.id)
      ? await readerStore.linkInsightToPlatform(insight.id, payload.draft.id, origin) : null;
    if (!connected()) return;
    if (linked && lastSavedInsight?.id === linked.id) lastSavedInsight = linked;
    void updatePageKnowledge({ refresh: true });
    insightSyncFailed = false;
    updateReadingModeUi();
    setNotice(payload.updated ? t("已更新 Deep Research 研究库中的收藏。") : t("已同步到 Deep Research 研究库。"));
  } catch (error) {
    if (!connected()) return;
    insightSyncFailed = true;
    updateReadingModeUi();
    if (error instanceof Error && /令牌|连接|AUTH_NOT_AUTHENTICATED/u.test(error.message)) setPlatformConnected(false, t("平台令牌已失效，请重新连接"));
    setNotice(error instanceof Error ? error.message : t("研究库同步失败"));
  }
}

async function syncCurrentSession({ quiet = false } = {}) {
  const generation = sessionGeneration;
  const events = platformStateEvents;
  const origin = platformUrl;
  const context = documentContext || pageContext || selectionContext;
  const current = () => generation === sessionGeneration && events === platformStateEvents
    && platformConnected && !platformDisconnecting && platformUrl === origin && context?.url === contextUrl();
  if (!current()) return;
  const readerToken = await readPlatformToken();
  if (!current()) return;
  if (!readerToken) { setNotice(t("先在设置中连接 Deep Research。")); return; }
  if (!context?.url) { setNotice(t("当前没有可同步的阅读会话。")); return; }
  const image = imageContext?.image;
  const state = {
    selection: selectionContext?.selection || null,
    answer: latestAnswer || '',
    answerStructured: latestStructuredAnswer || null,
    discussion: discussionHistory.map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: String(item.content || '').slice(0, 8_000),
      ...(item.webSources ? { webSources: item.webSources } : {}),
      ...(item.searchStatus ? { searchStatus: item.searchStatus } : {}),
    })),
    discussionScope,
    radarSummaryId: currentRadarSummaryId() || null,
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
    if (!current()) return;
    const version = context.contentHash || selectionContext?.selection?.contentHash || null;
    const idempotencyKey = await readerStore.getSessionSyncKey(context.url, version);
    if (!current()) return;
    const response = await fetch(`${origin}/api/reading/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${readerToken}` },
      body: JSON.stringify({
        clientId,
        idempotencyKey,
        document: {
          url: context.url,
          title: context.title || t("未命名页面"),
          version,
        },
        state,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!current()) return;
    if (!response.ok) throw new Error(payload.message || t("阅读会话同步失败"));
    if (!quiet) setNotice(t("当前阅读会话已同步；正文和翻译缓存仍只保存在本地。"));
  } catch (error) {
    if (!current()) return;
    if (error instanceof Error && /令牌|连接|AUTH_NOT_AUTHENTICATED/u.test(error.message)) setPlatformConnected(false, t("平台令牌已失效，请重新连接"));
    if (!quiet) setNotice(error instanceof Error ? error.message : t("阅读会话同步失败"));
  }
}

function platformContext(context, scope) {
  const body = String(context?.body || '');
  const selection = scope === 'selection' ? context?.selection : undefined;
  return {
    url: context.url,
    title: String(context.title || t("当前网页")).slice(0, 300),
    language: currentReadingLanguage(),
    scope,
    body,
    ...(typeof context.section === 'string' && context.section ? { section: context.section } : {}),
    ...(selection ? { selection } : {}),
  };
}


async function requestPlatformTranslations(context, blocks, options = {}) {
  context = { ...context, targetLanguage: context.targetLanguage || currentTranslationLanguage() };
  const readerToken = await readPlatformToken();
  if (!readerToken) throw new Error(t("平台连接已失效，请重新连接"));
  const tasks = splitTranslationBlocks(blocks);
  const output = [];
  const completedBySource = new Map();
  const completedSourceIds = new Set();
  const batches = translationBatches(tasks);
  let nextBatch = 0;
  let batchError = null;
  async function processBatch(batchIndex) {
    const batch = batches[batchIndex];
    const offset = batchIndex * 24;
    const requestIds = new Map(batch.map((block, index) => [block.id, `translation-${offset + index}`]));
    const response = await fetch(`${platformUrl}/api/reading/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${readerToken}` },
      body: JSON.stringify({
        url: context.url,
        title: String(context.title || t("当前网页")).slice(0, 300),
        language: (context.targetLanguage || currentTranslationLanguage()),
        context: translationContext(context, batch),
        blocks: batch.map(({ id, text }) => ({ id: requestIds.get(id), text })),
      }),
      signal: options.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) setPlatformConnected(false, t("平台连接已失效，请重新连接"));
      throw new Error(payload.message || t("平台 AI 翻译暂时不可用"));
    }
    const byId = new Map((Array.isArray(payload.translations) ? payload.translations : []).map((item) => [item.id, item]));
    for (const block of batch) {
      const result = byId.get(requestIds.get(block.id));
      const translated = result?.text ? { ...block, text: result.text, sourceText: block.text } : {
        ...block,
        text: '',
        sourceText: block.text,
        error: result?.error || t("平台没有返回该段翻译"),
      };
      output.push(translated);
      const sourceId = String(block.sourceBlockId || block.id);
      if (!completedBySource.has(sourceId)) completedBySource.set(sourceId, []);
      const parts = completedBySource.get(sourceId);
      parts.push(translated);
      if (parts.length === Number(block.partCount || 1)) {
        const sourceBlock = blocks.find((item) => String(item.id) === sourceId);
        const [combined] = combineTranslationParts(sourceBlock ? [sourceBlock] : [], parts);
        if (combined) {
          completedSourceIds.add(sourceId);
          await options.onResult?.(combined);
        }
      }
      options.onProgress?.(completedSourceIds.size, blocks.length, sourceId);
    }
  }
  async function batchWorker() {
    while (!batchError && nextBatch < batches.length) {
      const batchIndex = nextBatch++;
      if (options.signal?.aborted) {
        batchError = new DOMException(t("翻译已取消"), 'AbortError');
        return;
      }
      try {
        await processBatch(batchIndex);
      } catch (error) {
        batchError ||= error;
      }
    }
  }
  // Smaller context-aware batches paint early. Six in-flight requests match the
  // engine's LLM semaphore; measured wall time on a 287-block article dropped
  // ~45% versus three requests, with no loss of translated blocks.
  await Promise.all(Array.from({ length: Math.min(6, batches.length) }, () => batchWorker()));
  if (batchError) throw batchError;
  return blocks.map((block) => {
    const parts = output.filter((item) => String(item.sourceBlockId || item.id) === String(block.id));
    const [combined] = combineTranslationParts([block], parts);
    return combined || { ...block, text: '', sourceText: block.text, error: t("正文片段翻译不完整，请重试") };
  });
}

async function requestPlatformImageTranslation(context, image, options = {}) {
  context = { ...context, targetLanguage: context.targetLanguage || currentTranslationLanguage() };
  const readerToken = await readPlatformToken();
  if (!readerToken) throw new Error(t("平台连接已失效，请重新连接"));
  const imageProvider = {
    baseUrl: `${platformUrl}/api/reading`,
    model: 'platform-reading-vision',
    language: (context.targetLanguage || currentTranslationLanguage()),
    visionReady: true,
  };
  return translateImage(imageProvider, makeDocument(context), image, {
    signal: options.signal,
    fetchImageBytes: true,
    requireImageBytes: true,
    requestVision: async ({ imageDataUrl, userText, signal }) => {
      const response = await fetch(`${platformUrl}/api/reading/translate-image`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${readerToken}`,
        },
        body: JSON.stringify({
          imageDataUrl,
          alt: String(image.alt || '').slice(0, 500),
          title: String(context.title || t("技术文章配图")).slice(0, 300),
          language: (context.targetLanguage || currentTranslationLanguage()),
          retry: userText.includes('上一轮没有返回可定位的文字区域'),
        }),
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) setPlatformConnected(false, t("平台连接已失效，请重新连接"));
        throw new Error(payload.message || t("平台视觉模型暂时不可用"));
      }
      return payload;
    },
    requestText: async ({ userPrompt, signal }) => {
      const [translated] = await requestPlatformTranslations(context, [{ id: `svg-${image.id}`, text: userPrompt }], { signal });
      if (!translated?.text) throw new Error(translated?.error || t("SVG 图中文字翻译失败"));
      return { choices: [{ message: { content: translated.text } }] };
    },
  });
}

async function restoreCloudSession() {
  const generation = sessionGeneration;
  const events = platformStateEvents;
  const origin = platformUrl;
  const context = documentContext || pageContext || selectionContext;
  const current = () => generation === sessionGeneration && events === platformStateEvents
    && platformConnected && !platformDisconnecting && platformUrl === origin && context?.url === contextUrl();
  const readerToken = await readPlatformToken();
  if (!readerToken) { setNotice(t("先在设置中连接 Deep Research。"), $('settings-notice')); return; }
  if (!context?.url) { setNotice(t("当前没有可恢复的阅读页面。"), $('settings-notice')); return; }
  if (!current()) return;
  try {
    const clientId = await readerStore.getClientId();
    if (!current()) return;
    const response = await fetch(`${origin}/api/reading/session?clientId=${encodeURIComponent(clientId)}`, {
      headers: { authorization: `Bearer ${readerToken}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!current()) return;
    if (!response.ok) throw new Error(payload.message || t("云端会话读取失败"));
    const currentUrl = readerStore.pageKey(context.url);
    const remote = (Array.isArray(payload.sessions) ? payload.sessions : [])
      .filter((item) => item?.document?.url && readerStore.pageKey(item.document.url) === currentUrl)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (!remote) {
      setNotice(t("云端没有当前页面的同步会话。"), $('settings-notice'));
      return;
    }
    await readerStore.saveSession({
      ...(remote.state && typeof remote.state === 'object' ? remote.state : {}),
      url: remote.document.url,
      title: remote.document.title || context.title || t("未命名页面"),
      version: remote.document.version || null,
      updatedAt: remote.updatedAt || new Date().toISOString(),
    });
    if (!current()) return;
    // Force the local resume path to consume the freshly downloaded state.
    resumedUrls.delete(context.url);
    await resumeSession(context);
    if (!current()) return;
    setNotice(t("已恢复云端阅读会话；正文和翻译缓存仍只保存在本地。"), $('settings-notice'));
  } catch (error) {
    if (!current()) return;
    if (error instanceof Error && /令牌|连接|AUTH_NOT_AUTHENTICATED/u.test(error.message)) setPlatformConnected(false, t("平台令牌已失效，请重新连接"));
    setNotice(error instanceof Error ? error.message : t("云端会话读取失败"), $('settings-notice'));
  }
}

let modelDiscoveryController = null;
let modelDiscoveryTimer = null;
let providerFieldsDirty = false;
let providerFormKind = 'openai';
const providerFormDrafts = new Map();
let settingsModels = [];
let discoveredConnection = null;
let providerValidationController = null;
let verifiedSettingsConnection = null;

function renderProviderPickerSelection() {
  const selected = findProvider($('provider-kind').value);
  $('provider-picker-label').textContent = t(selected.label);
  $('provider-picker-subtitle').textContent = t(selected.subtitle);
  $('provider-picker-icon').src = `providers/${selected.icon}`;
  $('provider-picker-icon').classList.toggle('provider-logo-dark', selected.id === 'moonshot');
  for (const button of $('provider-picker-options').querySelectorAll('[data-provider-id]')) {
    button.setAttribute('aria-selected', String(button.dataset.providerId === selected.id));
  }
}

function filterProviderPicker() {
  const matches = new Set(matchingProviders($('provider-picker-search').value).map(item => item.id));
  for (const button of $('provider-picker-options').querySelectorAll('[data-provider-id]')) {
    show(button, matches.has(button.dataset.providerId));
  }
  for (const group of $('provider-picker-options').querySelectorAll('[data-provider-group]')) {
    show(group, Boolean(group.querySelector('[data-provider-id]:not(.hidden)')));
  }
  show($('provider-picker-empty'), matches.size === 0);
}

function positionProviderPicker() {
  const menu = $('provider-picker-menu');
  if (menu.classList.contains('hidden')) return;
  const rect = $('provider-picker-trigger').getBoundingClientRect();
  if (rect.bottom < 48 || rect.top > innerHeight) { closeProviderPicker(); return; }
  const below = innerHeight - rect.bottom - 14;
  const above = rect.top - 14;
  const useAbove = below < 280 && above > below;
  const available = Math.max(80, Math.min(440, (useAbove ? above : below) - 6));
  const width = Math.min(440, rect.width, innerWidth - 24);
  Object.assign(menu.style, {
    width: `${width}px`,
    left: `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`,
    top: useAbove ? 'auto' : `${rect.bottom + 6}px`,
    bottom: useAbove ? `${innerHeight - rect.top + 6}px` : 'auto',
    maxHeight: `${available}px`,
  });
}

function closeProviderPicker({ restoreFocus = false } = {}) {
  show($('provider-picker-menu'), false);
  $('provider-picker-trigger').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('provider-picker-trigger').focus();
}

function setupProviderPicker() {
  const choose = (id) => {
    $('provider-kind').value = id;
    $('provider-kind').dispatchEvent(new Event('change', { bubbles: true }));
    closeProviderPicker({ restoreFocus: true });
  };
  $('provider-picker-trigger').addEventListener('click', () => {
    if (!$('provider-picker-menu').classList.contains('hidden')) { closeProviderPicker(); return; }
    $('provider-picker-search').value = '';
    filterProviderPicker();
    renderProviderPickerSelection();
    show($('provider-picker-menu'), true);
    $('provider-picker-trigger').setAttribute('aria-expanded', 'true');
    positionProviderPicker();
    $('provider-picker-search').focus();
  });
  $('provider-picker-close').addEventListener('click', () => closeProviderPicker({ restoreFocus: true }));
  $('provider-picker-search').addEventListener('input', filterProviderPicker);
  $('provider-picker-custom').addEventListener('click', () => choose('custom'));
  for (const button of $('provider-picker-options').querySelectorAll('[data-provider-id]')) {
    button.addEventListener('click', () => choose(button.dataset.providerId));
  }
  $('provider-picker-menu').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeProviderPicker({ restoreFocus: true });
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target === $('provider-picker-search') && event.key !== 'ArrowDown') return;
    const options = [...$('provider-picker-options').querySelectorAll('[data-provider-id]:not(.hidden)')];
    if (!options.length) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : event.key === 'ArrowUp' ? (current <= 0 ? options.length - 1 : current - 1) : (current + 1) % options.length;
    options[index].focus();
  });
  document.addEventListener('pointerdown', event => {
    if (!$('provider-picker').contains(event.target)) closeProviderPicker();
  });
  document.addEventListener('focusin', event => {
    if (!$('provider-picker').contains(event.target)) closeProviderPicker();
  });
  $('settings-view').addEventListener('scroll', positionProviderPicker, { passive: true });
  window.addEventListener('resize', positionProviderPicker);
}

function providerFromFields() {
  const kind = $('provider-kind').value;
  return { providerKind: kind, baseUrl: $('provider-url').value.trim(), model: $('provider-model-list').value || $('provider-model').value.trim(), apiKey: $('provider-key').value.trim() };
}

function sameSettingsConnection(a, b) {
  try {
    return Boolean(a && b && a.providerKind === b.providerKind && a.apiKey === b.apiKey
      && normalizeModelBaseUrl(a.baseUrl, a.providerKind) === normalizeModelBaseUrl(b.baseUrl, b.providerKind));
  } catch { return false; }
}

function clearProviderErrors() {
  for (const id of ['provider-url', 'provider-key', 'provider-model-list']) $(id).removeAttribute('aria-invalid');
}

function resetProviderValidation() {
  const controller = providerValidationController;
  providerValidationController = null;
  controller?.abort();
  verifiedSettingsConnection = null;
  $('provider-test-status').textContent = '';
  $('test-provider').disabled = false;
  $('test-provider').textContent = t("测试连接");
}

function setDiscoveryState(state, message) {
  const busy = state === 'loading';
  const current = providerFromFields();
  const saved = providerReady(provider) && sameSettingsConnection(provider, current) && provider.model === current.model;
  const status = $('model-discovery-status');
  status.textContent = message;
  status.dataset.state = state;
  status.setAttribute('role', state === 'error' ? 'alert' : 'status');
  $('refresh-models').disabled = busy;
  $('refresh-models').setAttribute('aria-busy', String(busy));
  $('refresh-models').textContent = busy ? t("正在连接…") : state === 'ready' ? t("刷新模型列表") : t("连接并获取模型");
  $('provider-connection-state').textContent = busy ? t("连接中") : state === 'ready' ? t("模型已读取") : state === 'error' ? t("连接未完成") : saved ? t("已配置") : t("未连接");
  $('provider-connection-state').classList.toggle('connected', state === 'ready');
}

function showProviderError(error, candidate, target = $('model-discovery-status'), focusField = true) {
  const issue = modelConnectionError(error, candidate);
  if (target === $('model-discovery-status')) setDiscoveryState('error', issue.message);
  else { target.textContent = issue.message; target.dataset.state = 'error'; target.setAttribute('role', 'alert'); }
  if (issue.field && $(issue.field)) {
    $(issue.field).setAttribute('aria-invalid', 'true');
    if (focusField) $(issue.field).focus();
  }
  if (['MODELS_UNSUPPORTED', 'EMPTY_MODELS'].includes(issue.code)) $('manual-model-settings').open = true;
}

function renderSettingsModels(selected = $('provider-model-list').value || $('provider-model').value) {
  const query = $('provider-model-search').value.trim().toLocaleLowerCase();
  const models = sameSettingsConnection(discoveredConnection, providerFromFields()) ? settingsModels : [];
  const visible = models.filter(item => `${item.id} ${item.label}`.toLocaleLowerCase().includes(query));
  const list = $('provider-model-list');
  const items = visible.map(item => new Option(item.label, item.id));
  if (selected && !models.some(item => item.id === selected)) items.unshift(new Option(t("{0}（当前配置）", selected), selected));
  if (items.length && !items.some(item => item.value === selected)) items.unshift(new Option(t("请选择模型"), ''));
  list.replaceChildren(...(items.length ? items : [new Option(query ? t("没有匹配的模型") : t("请先连接模型服务"), '')]));
  if (items.some(item => item.value === selected)) list.value = selected;
  else if (query) list.value = '';
  show($('provider-model-search'), models.length > 6);
}

function changeProviderKind() {
  providerFormDrafts.set(providerFormKind, { ...providerFromFields(), providerKind: providerFormKind });
  const kind = $('provider-kind').value;
  const draft = providerFormDrafts.get(kind) || { baseUrl: providerPreset(kind).baseUrl, apiKey: '', model: '' };
  providerFormKind = kind;
  $('provider-url').value = draft.baseUrl;
  $('provider-key').value = draft.apiKey;
  $('provider-key').type = 'password';
  $('provider-key-toggle').setAttribute('aria-pressed', 'false');
  $('provider-key-toggle').setAttribute('aria-label', t("显示 API Key"));
  $('provider-key-toggle').title = t("显示 API Key");
  $('provider-model').value = draft.model;
  $('provider-model-search').value = '';
  discoveredConnection = null;
  settingsModels = [];
  $('provider-model-list').replaceChildren(new Option(draft.model || t("请先连接模型服务"), draft.model || ''));
  scheduleModelDiscovery();
}

async function refreshModels({ requestPermission = false } = {}) {
  clearTimeout(modelDiscoveryTimer);
  modelDiscoveryController?.abort();
  const controller = new AbortController();
  modelDiscoveryController = controller;
  let candidate = providerFromFields();
  clearProviderErrors();
  try {
    candidate = validateModelConnection(candidate);
    // Request host access in the click's gesture; automatic refresh never prompts.
    const permission = requestPermission ? requestOriginPermission(candidate.baseUrl) : Promise.resolve(true);
    setDiscoveryState('loading', requestPermission ? t("正在连接 {0}…", new URL(candidate.baseUrl).host) : t("正在读取模型列表…"));
    if (!(await permission)) throw new ModelConnectionError('PERMISSION', t("未允许访问这个服务，请再次点击连接并在 Chrome 中允许访问"));
    if (controller.signal.aborted) return;
    const models = await discoverModels(candidate, { signal: controller.signal });
    if (controller !== modelDiscoveryController) return;
    settingsModels = models;
    discoveredConnection = candidate;
    $('provider-model-search').value = '';
    const selected = candidate.model || '';
    $('provider-model').value = selected;
    renderSettingsModels(selected);
    $('manual-model-settings').open = false;
    providerFieldsDirty = true;
    setDiscoveryState('ready', t("已读取 {0} 个模型 · {1}", models.length, new URL(candidate.baseUrl).host));
  } catch (error) {
    if (controller !== modelDiscoveryController || controller.signal.aborted) return;
    showProviderError(error, candidate, $('model-discovery-status'), requestPermission);
  }
}

function scheduleModelDiscovery() {
  providerFieldsDirty = true;
  updateProviderForm();
  modelDiscoveryController?.abort();
  resetProviderValidation();
  clearProviderErrors();
  $('provider-model-search').value = '';
  renderSettingsModels();
  clearTimeout(modelDiscoveryTimer);
  let candidate;
  try { candidate = validateModelConnection(providerFromFields()); }
  catch (error) {
    setDiscoveryState('idle', error.code === 'KEY_REQUIRED' ? t("填写 API Key 后连接服务") : t("填写 API 地址后连接服务"));
    return;
  }
  setDiscoveryState('idle', t("等待连接 · {0}", new URL(candidate.baseUrl).host));
  modelDiscoveryTimer = setTimeout(async () => {
    const allowed = !chrome.permissions?.contains || await chrome.permissions.contains({ origins: [`${new URL(candidate.baseUrl).origin}/*`] }).catch(() => false);
    if (allowed && sameSettingsConnection(candidate, providerFromFields())) void refreshModels();
  }, 500);
}

async function testProvider(nextProvider, controller = new AbortController()) {
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const payload = await requestChat(nextProvider, [{ role: 'user', content: 'Reply with OK only. Do not reason.' }], { temperature: 0, maxTokens: 128, signal: controller.signal });
    if (!payload?.choices?.[0]?.message?.content && !payload?.content?.length) throw new ModelConnectionError('EMPTY_REPLY', t("服务已响应，但短验证没有返回文本；可保存后试用，或选择其他聊天模型"));
  } finally { clearTimeout(timer); }
}

async function testSettingsProvider() {
  let candidate = providerFromFields();
  const button = $('test-provider');
  const target = $('provider-test-status');
  providerValidationController?.abort();
  const controller = new AbortController();
  providerValidationController = controller;
  clearProviderErrors();
  try {
    candidate = validateModelConnection(candidate, { requireModel: true });
    const permission = requestOriginPermission(candidate.baseUrl);
    button.disabled = true;
    button.textContent = t("测试中…");
    target.dataset.state = 'loading';
    target.setAttribute('role', 'status');
    target.textContent = t("正在测试所选模型…");
    if (!(await permission)) throw new ModelConnectionError('PERMISSION', t("未允许访问这个服务，请重新测试并在 Chrome 中允许访问"));
    if (controller.signal.aborted) return;
    const started = Date.now();
    await testProvider(candidate, controller);
    if (!sameSettingsConnection(candidate, providerFromFields()) || candidate.model !== providerFromFields().model) return;
    verifiedSettingsConnection = candidate;
    target.dataset.state = 'verified';
    target.textContent = t("连接成功 · {0} · {1} 秒", candidate.model, ((Date.now() - started) / 1000).toFixed(1));
    $('provider-connection-state').textContent = t("测试通过");
  } catch (error) {
    if (controller !== providerValidationController) return;
    if (controller.signal.aborted && !sameSettingsConnection(candidate, providerFromFields())) return;
    showProviderError(error, candidate, target);
  } finally {
    if (controller === providerValidationController) { button.disabled = false; button.textContent = t("测试连接"); }
  }
}

async function saveSettings() {
  let nextProvider = providerFromFields();
  clearTimeout(modelDiscoveryTimer);
  modelDiscoveryController?.abort();
  const button = $('save-settings');
  button.disabled = true;
  clearProviderErrors();
  try {
    nextProvider = validateModelConnection(nextProvider, { requireModel: true });
    if (!(await requestOriginPermission(nextProvider.baseUrl))) throw new ModelConnectionError('PERMISSION', t("未允许访问这个服务，配置尚未保存"));
    if (!sameSettingsConnection(nextProvider, providerFromFields()) || nextProvider.model !== providerFromFields().model) return;
    const verified = sameSettingsConnection(verifiedSettingsConnection, nextProvider) && verifiedSettingsConnection.model === nextProvider.model;
    provider = await saveProvider({ ...nextProvider, ...(verified ? { connectionVerifiedAt: new Date().toISOString() } : {}) });
    providerFieldsDirty = false;
    applyProviderFields();
    setDiscoveryState('idle', t("配置已保存"));
    renderPersistentComposer();
    updateReadingModeUi();
    setNotice(t("模型配置已保存。"), $('settings-notice'));
    $('settings-notice').dataset.result = 'success';
  } catch (error) {
    showProviderError(error, nextProvider, $('provider-test-status'));
  } finally { button.disabled = false; }
}

async function startFullTranslation() {
  setWorkspaceView('chat');
  if (!textModelReady()) {
    showModelSetupGuidance(t("全文翻译"));
    return;
  }
  if (pageContext?.translationDetected && !window.confirm(t("检测到页面可能已有其他翻译插件。继续会在现有译文旁再次插入内容，是否仍要继续？"))) {
    setNotice(t("已取消全文翻译，请保留一个整页翻译器。"));
    return;
  }
  // Request image hosts while the button gesture is still active. A denial
  // must not block text translation; unreadable images remain visible as
  // explicit retry/authorization failures.
  const imagePermissionGranted = await requestImageOrigins((pageContext?.images || []).filter((image) => image.src && !image.dataUrl));
  if (!imagePermissionGranted) setNotice(t("未获得部分图片站点权限；正文会继续翻译，相关图片可授权后重试。"));
  // A page-level task replaces the temporary selection toolbar so it cannot
  // sit over translated paragraphs or intercept their inline controls.
  sendToPage({ type: 'deep-research:clear-native-selection' });
  if (pageContext?.displayedTranslationLanguage && pageContext.displayedTranslationLanguage !== currentTranslationLanguage()) {
    await sendToPage({ type: 'deep-research:restore-translations', silent: true });
    translatedTextIds.clear(); translatedImageIds.clear();
    pageContext.translatedBlockIds = []; pageContext.translatedImageIds = [];
    pageContext.displayedTranslationLanguage = '';
  }
  translationRequested = true;
  fullTranslationEnabled = true;
  translationPaused = false;
  cancellationRequested = false;
  translationRunning = true;
  activeTranslationRun += 1;
  const url = contextUrl();
  const version = pageContext?.contentHash || documentContext?.contentHash || null;
  const resumableJob = pendingJob || activeJobRecord;
  activeJobRecord = resumableJob?.documentUrl === url
    && resumableJob?.contentHash === version
    && resumableJob?.targetLanguage === currentTranslationLanguage()
    && ['queued', 'running', 'cancelled', 'failed', 'completed_with_errors'].includes(resumableJob.status)
    ? resumableJob
    : { id: `translation-${crypto.randomUUID()}`, documentUrl: url, contentHash: version, kind: 'text', status: 'queued', textDone: 0, textTotal: 0, imageDone: 0, imageTotal: 0 };
  failedTranslationItems = Array.isArray(activeJobRecord.failedItems) ? activeJobRecord.failedItems : [];
  pendingJob = null;
  persistJobPatch(activeJobRecord, { status: 'queued', targetLanguage: currentTranslationLanguage(), error: undefined });
  translationController?.abort();
  translationController = new AbortController();
  renderProgress();
  $('translation-summary').scrollIntoView({ block: 'nearest' });
  setNotice(platformModeReady() ? t("正在读取正文，随后交由调研平台 AI Engine 翻译…") : t("正在读取当前页面的正文和图片…"));
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
    persistJobPatch(job, { status: 'cancelled', error: t("用户取消了翻译"), tabId: undefined });
    chrome.runtime.sendMessage({ type: 'deep-research:translation-cancel', jobId: job.id }).catch(() => {});
  }
  setNotice(t("翻译已取消，已完成内容保留。再次点击“全文翻译”可以继续。"));
  renderProgress(job?.textDone || 0, job?.textTotal || 0, job?.imageDone || 0, job?.imageTotal || 0);
  saveLocalSession();
}

async function retryTranslationItem(item) {
  if (!item || retryingTranslationId || translationRunning) return;
  if (!textModelReady()) {
    showModelSetupGuidance(t("翻译重试"));
    return;
  }
  const sourceContext = documentContext || pageContext;
  const context = sourceContext ? { ...sourceContext, targetLanguage: activeJobRecord?.targetLanguage || currentTranslationLanguage() } : null;
  if (!context) {
    setNotice(t("当前页面正文尚未提取，无法重试。"));
    return;
  }
  const document = makeDocument(context);
  const controller = new AbortController();
  retryingTranslationId = item.id;
  renderTranslationFailures();
  updateTranslationLanguageUi();
  try {
    if (item.kind === 'text') {
      const block = (documentContext?.blocks || context.blocks || []).find((candidate) => candidate.id === item.id);
      if (!block) throw new Error(t("正文已变化，请重新开启全文翻译"));
      const results = platformModeReady()
        ? await requestPlatformTranslations(context, [block], { signal: controller.signal })
        : await translateBlocks(readingProvider(context.targetLanguage), document, [block], { signal: controller.signal });
      const [translated] = results;
      if (!translated?.text) throw new Error(translated?.error || t("正文翻译结果为空"));
      const [applied] = await applyTextTranslations([{ ...translated, targetLanguage: context.targetLanguage }], payload => sendToPage({ ...payload, documentUrl: context.url }));
      if (applied?.error) throw new Error(applied.error);
      persistJobPatch(activeJobRecord, { appliedTextIds: mergeProcessedIds(activeJobRecord?.appliedTextIds || [], [item.id]) });
      translatedTextIds.add(item.id);
    } else {
      const image = (documentContext?.images || context.images || []).find((candidate) => candidate.id === item.id);
      if (!image) throw new Error(t("图片已变化，请重新开启全文翻译"));
      const permissionGranted = await requestImageOrigins(image.src && !image.dataUrl ? [image] : []);
      if (!permissionGranted && !image.dataUrl) throw new Error(t("未获得图片站点权限；允许后可重试图片翻译。"));
      const translated = platformModeReady()
        ? await requestPlatformImageTranslation(context, image, { signal: controller.signal })
        : await translateImage(readingProvider(context.targetLanguage), document, image, { signal: controller.signal, fetchImageBytes: true });
      if (!translated.regions?.length && !translated.fallbackText && !translated.fallbackRegions?.length && !translated.noText && !translated.keptOriginal) throw new Error(translated.note || t("图片没有可安全显示的译文"));
      if (translated.regions?.length || translated.fallbackText || translated.fallbackRegions?.length) sendToPage({ type: 'deep-research:apply-image-translations', translations: [translated] });
      translatedImageIds.add(item.id);
    }
    failedTranslationItems = failedTranslationItems.filter((candidate) => candidate.id !== item.id);
    persistJobPatch(activeJobRecord, {
      failedItems: failedTranslationItems,
      status: failedTranslationItems.length ? 'completed_with_errors' : 'completed',
      completedAt: new Date().toISOString(),
    });
    setNotice(failedTranslationItems.length ? t("已完成一项，还剩 {0} 项。", failedTranslationItems.length) : t("失败项已全部完成。"));
  } catch (error) {
    const message = error instanceof Error ? error.message : t("重试失败");
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
  const controller = translationController;
  const targetTabId = boundWindowTabId || activeTabId;
  const completionNotice = context.scope === 'selection'
    ? t("选段翻译完成。可以选择、复制或放大原文旁的译文。")
    : t("全文翻译完成。可以滚动阅读，或选择一段文字继续追问。");
  const usePlatform = platformModeReady();
  context = boundTaskContext({ ...context, targetLanguage: currentTranslationLanguage() }, { preserveAllBlocks: true });
  documentContext = context;
  updatePageContextUi(context);
  const coverageWarning = translationCoverageWarning(context);

  // Long-running translation belongs to the MV3 service worker. The side
  // panel is a disposable view: closing it must not abort an in-flight job.
  // If the worker cannot accept the task, retain the local fallback below so
  // a browser with an unusual extension runtime still remains usable.
  if (!usePlatform && job?.id && Number.isInteger(activeTabId)) {
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
  failedTranslationItems = mergeTranslationFailures(failedTranslationItems, [], [], context);
  const cachedTranslations = (job?.targetLanguage === context.targetLanguage && Array.isArray(job?.textTranslations) ? job.textTranslations : []).filter((item) => item.text && blocks.some((block) => block.id === item.id && block.text === item.sourceText));
  const pageTranslatedIds = context.displayedTranslationLanguage === context.targetLanguage ? (context.translatedBlockIds || []) : [];
  const completedTextIds = new Set([...cachedTranslations.map((item) => item.id), ...pageTranslatedIds]);
  const appliedTextIds = new Set([...(context.full ? [] : (job?.appliedTextIds || [])), ...pageTranslatedIds]);
  const applyTranslations = async (items) => {
    const results = await applyTextTranslations(items.map(item => ({ ...item, targetLanguage: context.targetLanguage })), payload => sendToPage({ ...payload, documentUrl: context.url }, targetTabId));
    if (runId !== activeTranslationRun) return results;
    for (const item of results) {
      if (item.text) { appliedTextIds.add(item.id); translatedTextIds.add(item.id); }
      else { appliedTextIds.delete(item.id); translatedTextIds.delete(item.id); }
    }
    persistJobPatch(job, { appliedTextIds: [...appliedTextIds] });
    return results;
  };
  if (cachedTranslations.length) await applyTranslations(cachedTranslations);
  const processedTextIds = mergeProcessedIds(Array.isArray(job?.processedTextIds) ? job.processedTextIds : [], [...completedTextIds])
    .filter((id) => !context.full || blocks.some((block) => block.id === id));
  const processedImageIds = Array.isArray(job?.processedImageIds) ? job.processedImageIds : [];
  const blockIds = blocks.map((block) => block.id).filter(Boolean);
  const imageIds = images.map((image) => image.id).filter(Boolean);
  const textTotal = context.full ? blocks.length : Math.max(Number(job?.textTotal) || 0, new Set([...processedTextIds, ...blockIds]).size);
  const skippedTextIds = mergeProcessedIds(context.full ? [] : (job?.skippedTextIds || []), blocks.filter((block) => block.kind === 'code').map((block) => block.id));
  let textDone = 0;
  let imageDone = 0;
  const translatableBlocks = blocks.filter((block) => block.kind !== 'code' && !completedTextIds.has(block.id));
  const skippedCodeBlocks = blocks.length - translatableBlocks.length;
  textDone = skippedCodeBlocks;
  persistJobPatch(job, {
    status: 'running',
    documentUrl: context.url || job?.documentUrl || '',
    contentHash: context.contentHash || context.version || job?.contentHash || null,
    targetLanguage: context.targetLanguage,
    textDone: context.full ? processedTextIds.length : Math.max(Number(job?.textDone) || 0, processedTextIds.length),
    textTotal: textTotal,
    imageDone: Math.max(Number(job?.imageDone) || 0, processedImageIds.length),
    imageTotal: Math.max(Number(job?.imageTotal) || 0, new Set([...processedImageIds, ...imageIds]).size),
    processedTextIds,
    appliedTextIds: [...appliedTextIds],
    skippedTextIds,
    processedImageIds,
    failedItems: failedTranslationItems,
  });
  renderProgress(Math.max(Number(job?.textDone) || 0, processedTextIds.length), textTotal, Math.max(Number(job?.imageDone) || 0, processedImageIds.length), Math.max(Number(job?.imageTotal) || 0, new Set([...processedImageIds, ...imageIds]).size));
  const imageLimitNotice = context.imageTruncated
    ? t("图片超过处理上限，已列出 {0}/{1} 张，未处理部分已明确保留。", images.length, context.imageCandidateCount || images.length)
    : '';
  setNotice(usePlatform
    ? t("正文与图片文字翻译通过调研平台 AI Engine 处理；图片字节仅在本次操作中由浏览器读取并按需上传，不会上传图片 URL。{0}{1}", coverageWarning ? `\n${coverageWarning}` : '', imageLimitNotice ? `\n${imageLimitNotice}` : '')
    : t("正文翻译会按块处理；图片无法翻译时保留原图并继续。{0}{1}", coverageWarning ? `\n${coverageWarning}` : '', imageLimitNotice ? `\n${imageLimitNotice}` : ''));
  try {
    const translationOptions = {
      signal: controller.signal,
      // Apply each completed block immediately. Waiting for every paragraph
      // made a long page feel frozen even though the model was already
      // returning usable results.
      onResult: async (item) => {
        if (runId !== activeTranslationRun || !item?.text) return;
        const savedResults = new Map((job.textTranslations || []).map((result) => [result.id, result]));
        savedResults.set(item.id, item);
        persistJobPatch(job, {
          textTranslations: [...savedResults.values()],
          processedTextIds: mergeProcessedIds(job.processedTextIds || [], [item.id]),
        });
        await applyTranslations([item]);
      },
      onProgress: (done) => {
        textDone = Math.max(Number(job?.textDone) || 0, done + skippedCodeBlocks);
        renderProgress(textDone, textTotal, imageDone, Math.max(Number(job?.imageTotal) || 0, new Set([...processedImageIds, ...imageIds]).size));
        persistJobPatch(job, { textDone, textTotal: textTotal });
      },
    };
    let translations = usePlatform
      ? await requestPlatformTranslations(context, translatableBlocks, translationOptions)
      : await translateBlocks(readingProvider(context.targetLanguage), document, translatableBlocks, translationOptions);
    job.processedTextIds = mergeProcessedIds(processedTextIds, [
      ...translations.filter((item) => item.text || item.error).map((item) => item.id),
      ...blocks.filter((block) => block.kind === 'code').map((block) => block.id),
    ]);
    if (runId !== activeTranslationRun) return;
    const finalResults = await applyTranslations([...cachedTranslations, ...translations.filter((item) => item.text)]);
    const renderedById = new Map(finalResults.map((item) => [item.id, item]));
    translations = [...cachedTranslations, ...translations].map((item) => renderedById.get(item.id) || item);
    const imageTranslations = [];
    for (const image of images) {
      if (controller.signal.aborted) throw new DOMException(t("翻译已取消"), 'AbortError');
      try {
        const translated = usePlatform
          ? await requestPlatformImageTranslation(context, image, { signal: controller.signal })
          : await translateImage(readingProvider(context.targetLanguage), document, image, { signal: controller.signal, fetchImageBytes: true });
        imageTranslations.push(translated);
      } catch (error) {
        if (controller.signal.aborted) throw new DOMException(t("翻译已取消"), 'AbortError');
        imageTranslations.push({ ...image, regions: [], confidence: 0, note: error instanceof Error ? error.message : t("图片翻译失败") });
      }
      imageDone += 1;
      job.processedImageIds = mergeProcessedIds(processedImageIds, imageTranslations.filter((item) => !item.skipped).map((item) => item.id).filter(Boolean));
      renderProgress(textDone, textTotal, imageDone, Math.max(Number(job?.imageTotal) || 0, new Set([...job.processedImageIds, ...imageIds]).size));
      persistJobPatch(job, { imageDone, imageTotal: Math.max(Number(job?.imageTotal) || 0, new Set([...job.processedImageIds, ...imageIds]).size), processedImageIds: job.processedImageIds });
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
        error: item.note || t("图片翻译失败"),
      })));
    const resolvedIds = [
      ...translations.filter((item) => item.text).map((item) => item.id),
      ...imageTranslations.filter((item) => item.regions?.length || item.fallbackText || item.noText || item.keptOriginal).map((item) => item.id),
    ].filter(Boolean);
    failedTranslationItems = mergeTranslationFailures(failedTranslationItems, currentFailures, resolvedIds);
    const imageWarnings = imageTranslations
      .filter((item) => item.noText || item.keptOriginal || (item.fallbackText && item.note) || item.sourceWarning)
      .map((item) => t("图片 {0}: {1}", item.id, [item.sourceWarning, item.skipped ? '已跳过并保留原图' : '', item.noText ? '未发现可可靠读取的文字' : '', item.keptOriginal && !item.skipped ? '图片文字为技术标识符，保留原文' : '', item.note].filter(Boolean).join('；')));
    renderTranslationFailures();
    const failures = failedTranslationItems.map((item) => `${item.kind === 'image' ? t("图片") : t("正文")} ${item.id}: ${item.error}`);
    setNotice(failures.length
      ? t("翻译完成，但有 {0} 项需要重试。\n{1}", failures.length, [...failures, coverageWarning, ...imageWarnings].filter(Boolean).slice(0, 5).join('\n'))
      : imageWarnings.length
        ? `${coverageWarning ? t("已翻译可处理正文，未覆盖部分没有翻译。") : t("全文翻译完成。")}${coverageWarning ? `\n${coverageWarning}` : ''}\n${imageWarnings.slice(0, 3).join('\n')}`
        : coverageWarning
          ? t("已翻译可处理正文，未覆盖部分没有翻译。\n{0}", coverageWarning)
          : completionNotice);
    if (runId === activeTranslationRun) persistJobPatch(job, {
      status: failedTranslationItems.length ? 'completed_with_errors' : 'completed',
      textDone,
      textTotal: textTotal,
      imageDone: Math.max(Number(job?.imageDone) || 0, imageDone),
      imageTotal: Math.max(Number(job?.imageTotal) || 0, new Set([...job.processedImageIds, ...imageIds]).size),
      processedTextIds: job.processedTextIds,
      processedImageIds: job.processedImageIds,
      failedItems: failedTranslationItems,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (runId === activeTranslationRun) {
      if (error instanceof DOMException && error.name === 'AbortError') setNotice(t("翻译已暂停。再次点击全文翻译会从缓存结果继续。"));
      else setNotice(error instanceof Error ? error.message : t("全文翻译失败"));
    }
    if (runId === activeTranslationRun) persistJobPatch(job, { status: error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : t("全文翻译失败") });
  } finally {
    if (runId === activeTranslationRun) {
      translationRunning = false;
      renderProgress(textDone, textTotal, imageDone, Math.max(Number(job?.imageTotal) || 0, new Set([...processedImageIds, ...imageIds]).size));
      saveLocalSession();
    }
  }
}

const FULL_PAGE_SUMMARY_PROMPT = '请总结整篇技术文章，并严格按 Markdown 输出四个独立小节，每个小节标题单独占一行，格式为“## 1. 核心结论”……“## 4. 值得继续核对”。小节 1 概括文章解决的问题和结论；小节 2 概括关键机制或架构；小节 3 概括重要取舍、适用边界和失败条件；小节 4 只列出最多 3 个简短、可检验的核对点，并在每项末尾用 [1]、[2] 引用下方原文证据编号。不要在回答正文粘贴长引文，不要重复证据卡内容。每节最多 3 个要点，总回答控制在 1000 个汉字以内；最多 4 条证据，每条原文短引不超过 140 字，claim 不超过 100 字。只基于当前页面正文，不要把未出现的信息说成文章结论。';
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
  if (intent === 'translate') return `请将当前选段翻译成${currentTranslationLanguage()}，保留 API、类名、函数名、命令、代码和技术标识符；只翻译自然语言，不要补充解释。`;
  if (intent === 'explain') return scope === 'image' ? '请解释这张技术图示。' : '请解释当前技术内容，指出它解决的问题、关键机制和一个具体例子。';
  return scope === 'image' ? '请围绕当前技术图示回答问题。' : '';
}

function discussionUserLabel(scope, intent, question = '') {
  const explicitQuestion = String(question || '').trim();
  if (explicitQuestion) return explicitQuestion;
  if (intent === 'summary') return t("总结本页");
  if (intent === 'map') return t("梳理文章地图");
  if (intent === 'architecture') return t("分析关键机制");
  if (intent === 'tradeoffs') return t("审查风险与取舍");
  if (intent === 'selection-summary') return t("总结当前选段");
  if (intent === 'translate') return t("翻译当前选段");
  if (intent === 'explain') {
    if (scope === 'image') return t("解读当前图示");
    if (scope === 'selection') return t("解释当前选段");
    return t("解释当前页面");
  }
  if (scope === 'image') return t("围绕当前图示提问");
  if (scope === 'selection') return t("围绕当前选段提问");
  return t("围绕当前页面提问");
}

function revealDiscussion({ focusInput = false } = {}) {
  window.setTimeout(() => {
    if (focusInput) $('question-input')?.focus({ preventScroll: true });
  }, 0);
}

function renderPendingAnswer() {
  const turn = $('pending-turn');
  if (!turn) return;
  const visible = Boolean(discussionRunning && pendingAnswer);
  show(turn, visible);
  turn.setAttribute('aria-busy', String(discussionRunning));
  if (!pendingAnswer) return;
  $('pending-question').textContent = pendingAnswer.userMessage;
  $('answer-progress-text').textContent = pendingAnswer.status;
  const output = $('answer-output');
  if (output.dataset.streamed !== pendingAnswer.streamedText) {
    renderMarkdown(output, pendingAnswer.streamedText || '', { streaming: true });
    output.dataset.streamed = pendingAnswer.streamedText || '';
  }
  show($('answer-output'), Boolean(pendingAnswer.streamedText));
}

function updatePendingAnswer(update = {}) {
  if (!pendingAnswer) return;
  const transcript = $('chat-transcript');
  const followOutput = transcript && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 96;
  if (update.status) pendingAnswer.status = update.status;
  if (typeof update.streamedText === 'string') pendingAnswer.streamedText = update.streamedText;
  renderPendingAnswer();
  if (followOutput) requestAnimationFrame(() => { transcript.scrollTop = transcript.scrollHeight; });
}

function revealPendingAnswer() {
  const transcript = $('chat-transcript');
  if (!transcript) return;
  requestAnimationFrame(() => transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' }));
}

function openDiscussion(scope = 'page', intent = 'ask') {
  setWorkspaceView('chat');
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
      ? t("问问这段内容…")
      : nextScope === 'image'
        ? t("问问这张图…")
        : t("问问这篇文章…");
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
    setNotice(requested === 'selection' ? t("先在原网页选择一段正文。") : t("先在原网页点击一张图示。"));
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
    setNotice(t("正在读取当前页面，动作会在正文准备好后继续。"));
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

async function resumeBackgroundAnswer(context) {
  const snapshot = await chrome.runtime.sendMessage({ type: 'deep-research:answer-current', url: context.url, contentHash: context.contentHash });
  if (!snapshot || discussionRunning || context.url !== contextUrl()) return;
  const presentation = answerTaskPresentation(snapshot);
  const input = $('question-input');
  // Remove only a draft proven to be the internal prompt from an older task.
  // Unrelated text the user has started typing must survive task recovery.
  if (snapshot.prompt && snapshot.prompt !== snapshot.question && input.value.trim() === snapshot.prompt.trim()) {
    input.value = '';
    persistQuestionDraft();
  }
  if (['failed', 'interrupted'].includes(snapshot.status)) {
    setNotice(t("上次回答未完成：{0}", snapshot.error || t("回答未完成，请重试")));
    if (!input.value && presentation.draft) { input.value = presentation.draft; persistQuestionDraft(); }
    return;
  }
  if (snapshot.status !== 'running') return;
  discussionController = new AbortController();
  discussionSubscription = new AbortController();
  const subscription = discussionSubscription;
  discussionRunning = true; discussionOpen = true;
  pendingAnswer = { userMessage: presentation.userMessage || t("继续回答"), status: t("正在继续后台回答…"), streamedText: snapshot.streamed ? streamAnswerPreview(snapshot.streamed) : '' };
  renderPage(); renderPersistentComposer();
  revealPendingAnswer();
  try {
    const result = await waitForAnswerTask(snapshot.id, {
      signal: discussionController.signal,
      detachSignal: subscription.signal,
      onProgress: (done, total, phase) => { if (context.url === contextUrl()) updatePendingAnswer({ status: answerProgressText(done, total, phase) }); },
      onDelta: text => { if (context.url === contextUrl()) updatePendingAnswer({ status: t("正在生成回答…"), streamedText: streamAnswerPreview(text) }); },
    });
    if (context.url === contextUrl()) {
      const session = await readerStore.getReadingSession(context.url, context.contentHash || null);
      discussionHistory = session?.discussion || discussionHistory;
      latestStructuredAnswer = result; latestAnswer = result.answer || '';
      latestAnswerContext = { ...context, radarSummaryId: normalizeRadarSummaryId(session?.radarSummaryId) || undefined, scope: session?.discussionScope || 'page', selection: session?.selection || null };
      renderConversation(); renderStructuredAnswer(result);
    }
  } catch (error) { if (context.url === contextUrl() && error.name !== 'AbortError') setNotice(error.message || t("回答未完成")); }
  finally { if (discussionSubscription === subscription) { discussionRunning = false; pendingAnswer = null; renderPendingAnswer(); renderPersistentComposer(); } }
}

async function explainOrAsk(question = '', scope = discussionScope, intent = discussionIntent) {
  if (discussionRunning) { setNotice(t("当前回答仍在继续。可以选择下一段，或点击停止回答后再发起新问题。")); return; }
  const imagePermission = scope === 'image' && imageContext?.image && !imageContext.image.dataUrl ? requestImageOrigins([imageContext.image]) : Promise.resolve(true);
  const current = pageContext || documentContext || selectionContext;
  if (current) await resumeSession(current);
  if (discussionRunning || current?.url !== contextUrl()) return;
  interactionGeneration += 1;
  const normalizedIntent = DISCUSSION_INTENTS.has(intent) ? intent : 'ask';
  const sourceContext = scope === 'page' || scope === 'image' ? (documentContext || pageContext) : selectionContext;
  const image = scope === 'image' ? imageContext?.image : null;
  if (!sourceContext || (scope === 'selection' && !sourceContext.selection?.quote) || (scope === 'image' && !image)) {
    setNotice(scope === 'image' ? t("先在原网页点击一张图示的“解读”按钮。") : t("先在原网页选择一段正文，或先打开整页讨论。"));
    return;
  }
  if (scope === 'page' && !contextHasReadableBody(sourceContext)) {
    pageReadState = 'error';
    updatePageContextUi(sourceContext);
    renderPersistentComposer(scope);
    setNotice(t("没有提取到可用于问答的正文。请重新加载页面，或先选择一段原文后提问。"));
    return;
  }
  if (scope === 'image' && !platformModeReady() && !providerReady(provider)) {
    showModelSetupGuidance(t("图示解读"));
    return;
  }
  if (!textModelReady()) {
    const setupAction = scope === 'selection'
      ? normalizedIntent === 'ask' ? t("选段问答")
        : normalizedIntent === 'translate' ? t("选段翻译")
          : normalizedIntent === 'selection-summary' ? t("选段总结") : t("选段解读")
      : normalizedIntent === 'summary' ? t("全文总结")
        : normalizedIntent === 'map' ? t("文章地图")
          : normalizedIntent === 'architecture' ? t("关键机制分析")
            : normalizedIntent === 'tradeoffs' ? t("风险与取舍分析")
              : normalizedIntent === 'translate' ? t("全文翻译")
                : normalizedIntent === 'ask' ? t("整页问答") : t("整页解读");
    showModelSetupGuidance(setupAction);
    return;
  }
  setNotice('');
  discussionScope = scope;
  discussionIntent = normalizedIntent;
  if (scope === 'selection') sendToPage({ type: 'deep-research:clear-native-selection' });
  discussionOpen = true;
  setWorkspaceView('chat');
  renderDiscussionContext(scope, normalizedIntent, sourceContext);
  latestStructuredAnswer = null;
  latestAnswerContext = {
    ...sourceContext,
    radarSummaryId: currentRadarSummaryId(sourceContext.url) || undefined,
    scope,
    ...(scope === 'selection' ? { selection: sourceContext.selection } : {}),
  };
  renderStructuredAnswer(null);
  show($('discussion-section'), true);
  revealDiscussion();
  discussionController?.abort();
  discussionController = new AbortController();
  discussionSubscription = new AbortController();
  const subscription = discussionSubscription;
  discussionRunning = true;
  renderPersistentComposer(scope);
  latestAnswer = '';
  let streamBuffer = '';
  const requestSource = { ...sourceContext, scope };
  const requestHistory = [...discussionHistory];
  const submittedDraft = question && $('question-input').value.trim() === question.trim() ? $('question-input').value : '';
  // The pending turn owns the submitted question. Persist its cleared draft
  // before a page switch so it cannot reappear on return or sidebar reload.
  if (submittedDraft) { $('question-input').value = ''; persistQuestionDraft(); }
  const userMessage = discussionUserLabel(scope, normalizedIntent, question);
  pendingAnswer = {
    userMessage,
    status: scope === 'selection' ? t("正在读取所选原文…") : scope === 'image' ? t("正在分析当前图示…") : t("正在读取文章内容…"),
    streamedText: '',
  };
  renderConversation();
  renderPendingAnswer();
  revealPendingAnswer();
  const requestPrompt = question || discussionPrompt(scope, normalizedIntent);
  const taskController = discussionController;
  const stillVisible = () => discussionSubscription === subscription && contextUrl() === requestSource.url;
  const updateWaiting = (text) => { if (stillVisible()) updatePendingAnswer({ status: text }); };
  try {
    if (!(await imagePermission)) throw new Error(t("未获得图片站点权限，请授权后重试。"));
    const preparedImage = image ? await prepareVisionImage(image, { signal: taskController.signal }) : image;
    const result = await requestAnswerTask({
      id: `answer-${crypto.randomUUID()}`, context: requestSource, question: requestPrompt,
      history: requestHistory, userMessage, scope, intent: normalizedIntent,
      webSearch: webSearchEnabled && normalizedIntent === 'ask' && Boolean(question),
      mode: platformModeReady() ? 'platform' : 'standalone',
      platformUrl, language: currentReadingLanguage(), replyLanguage: normalizedIntent === 'translate' ? currentTranslationLanguage() : question ? 'auto' : currentReadingLanguage(), image: preparedImage,
      action: !question && normalizedIntent === 'explain' ? 'explain' : !question && normalizedIntent === 'translate' ? 'translate' : 'ask',
      maxTokens: normalizedIntent === 'summary' ? 6000 : 5000,
    }, {
      signal: taskController.signal,
      detachSignal: subscription.signal,
      onProgress: (done, total, phase) => updateWaiting(answerProgressText(done, total, phase)),
      onDelta: text => { if (stillVisible()) { streamBuffer = text; updatePendingAnswer({ status: t("正在生成回答…"), streamedText: streamAnswerPreview(text) }); } },
    });
    if (!stillVisible()) return;
    latestStructuredAnswer = typeof result === 'string' ? { answer: result, evidence: [], background: '', inference: '', limitations: [], warnings: [] } : result;
    if (requestSource.contentHash && requestSource.contentHash !== (pageContext?.contentHash || documentContext?.contentHash)) latestStructuredAnswer = { ...latestStructuredAnswer, evidence: [], warnings: [...(latestStructuredAnswer.warnings || []), t("页面内容已更新，旧引文定位已撤销。")] };
    latestAnswer = latestStructuredAnswer.answer || '';
    discussionHistory = [
      ...discussionHistory,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: latestAnswer, webSources: latestStructuredAnswer.webSources || [], searchStatus: latestStructuredAnswer.searchStatus },
    ];
    discussionRunning = false;
    pendingAnswer = null;
    renderPendingAnswer();
    renderPersistentComposer(scope);
    renderConversation();
    renderStructuredAnswer(latestStructuredAnswer);
    show($('answer-output'), false);
    // Keep the reading position when the streamed answer gains supporting details.
    saveLocalSession();
  } catch (error) {
    if (!stillVisible()) return;
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (!$('question-input').value && submittedDraft) { $('question-input').value = submittedDraft; persistQuestionDraft(); }
      discussionRunning = false;
      pendingAnswer = null;
      renderPendingAnswer();
      renderPage();
      return;
    }
    discussionRunning = false;
    pendingAnswer = null;
    renderPendingAnswer();
    renderPersistentComposer(scope);
    if (!$('question-input').value && submittedDraft) { $('question-input').value = submittedDraft; persistQuestionDraft(); }
    latestAnswer = '';
    latestStructuredAnswer = null;
    latestAnswerContext = null;
    $('answer-output').textContent = '';
    renderConversation();
    show($('answer-output'), false);
    renderStructuredAnswer(null);
    setNotice(error instanceof Error ? t(error.message) : t("解读失败"));
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
  if (!source?.anchor?.quote) { setNotice(t("先在原网页选择一段正文。")); return; }
  editingAnnotation = annotation;
  const dialog = ensureAnnotationDialog();
  show($('page-view'), false);
  show($('empty-view'), false);
  show($('settings-view'), false);
  show(ensureSaveDialog(), false);
  show(dialog, true);
  $('annotation-source-title').textContent = source.document?.title || selectionContext?.title || t("当前页面");
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
  if (!anchor?.quote || !context?.url) { setNotice(t("当前原文锚点已失效，请重新选择。"), $('annotation-notice')); return; }
  const version = context.contentHash || context.version || anchor.contentHash || null;
  if (!version) { setNotice(t("当前页面还没有稳定版本指纹，请等待正文提取后重试。"), $('annotation-notice')); return; }
  const saved = await readerStore.saveAnnotation({
    ...(editingAnnotation || {}),
    id: editingAnnotation?.id,
    document: { url: context.url, title: context.title || t("未命名页面"), version },
    anchor: { ...anchor, contentHash: anchor.contentHash || version },
    note,
  });
  editingAnnotation = null;
  pendingAnnotationHighlightId = saved.id;
  sendToPage({ type: 'deep-research:apply-annotation', annotation: saved });
  showReading();
  setNotice(t("标注已保存，正在原文中定位高亮。"));
  await updateLibrary();
}

function openSaveDialog(insight = null) {
  const source = insight || latestAnswerSource() || (selectionContext?.selection?.quote ? {
    title: selectionContext.title,
    url: selectionContext.url,
    document: { url: selectionContext.url, title: selectionContext.title, version: selectionContext.contentHash || selectionContext.version || selectionContext.selection.contentHash || null },
    quote: selectionContext.selection.quote,
    note: '',
    aiAnswer: latestAnswer,
    anchor: selectionContext.selection,
    tags: [],
  } : null);
  if (!source) { setNotice(t("先生成回答，或在原网页选择一段正文。")); return; }
  editingInsight = insight;
  pendingInsightSource = insight ? { ...insight } : readerStore.captureInsightSource(source, {
    url: contextUrl(), radarSummaryId: currentRadarSummaryId(),
  });
  const dialog = ensureSaveDialog();
  show($('page-view'), false);
  show($('empty-view'), false);
  show($('settings-view'), false);
  show(ensureAnnotationDialog(), false);
  show(dialog, true);
  const destination = platformModeReady()
    ? t("确认后保存到调研平台研究库。")
    : readingMode === 'platform'
      ? t("平台尚未连接，本次会保存在浏览器本地。")
      : t("独立模式下保存在浏览器本地。");
  $('save-mode-note').textContent = t("保存为可检索的阅读结论卡：原文摘录、笔记、AI 结论和标签；不会在原文添加高亮。{0}", destination);
  $('confirm-save').textContent = platformModeReady() ? t("保存到调研平台") : t("保存到本地阅读库");
  $('save-source-title').textContent = source.title || source.document?.title || t("当前页面");
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
  const connectionEvents = platformStateEvents;
  const quote = $('save-quote').value.trim();
  if (!quote) { setNotice(t("至少保留一段原文摘录。"), $('save-notice')); $('save-quote').focus(); return; }
  const source = editingInsight || pendingInsightSource;
  const url = source?.url || source?.document?.url || '';
  const title = source?.title || source?.document?.title || t("未命名页面");
  if (!url) { setNotice(t("当前页面来源缺失，请重新选择原文。"), $('save-notice')); return; }
  const tags = $('save-tags').value.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 10);
  const sourceVersion = source?.document?.version
    || source?.version
    || source?.contentHash
    || source?.anchor?.contentHash
    || null;
  const saved = await readerStore.saveInsight({
    ...(editingInsight || {}),
    id: editingInsight?.id,
    title,
    url,
    radarSummaryId: normalizeRadarSummaryId(source.radarSummaryId) || undefined,
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
        : undefined,
  });
  lastSavedInsight = saved;
  insightSyncFailed = false;
  editingInsight = null;
  pendingInsightSource = null;
  // The token in local storage is the durable source of truth.  The callback
  // message and the panel's in-memory flag may arrive in either order, so a
  // just-confirmed save must re-read it before deciding whether to expose the
  // sync action.
  const token = await readPlatformToken();
  if (token && !platformConnected && !platformDisconnecting && connectionEvents === platformStateEvents) setPlatformConnected(true, t("已连接 · {0}", platformUrl));
  showReading();
  show($('sync-selection'), false);
  if (platformModeReady()) {
    await syncInsight(saved);
  } else {
    setNotice(t("已保存到本地阅读库。"), $('notice'));
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
    setNotice(t("当前页面无法申请访问权限，请切换到普通网页后重试。"));
    return;
  }
  // Start the permission request before the first await so Chrome keeps the
  // user gesture from the side-panel button attached to this prompt.
  const permissionRequest = chrome.permissions.request({ origins: [target.origin] });
  try {
    const granted = await permissionRequest;
    if (!granted) {
      setNotice(t("没有获得当前站点权限；页面内容仍未读取。"));
      return;
    }
    const result = await chrome.runtime.sendMessage({ type: 'deep-research:activate-current-page', tabId: target.tabId });
    if (!result?.ok) {
      setNotice(result?.error || t("当前页面无法启用阅读。"));
      return;
    }
    activationNeeded = null;
    setNotice(t("已启用当前站点，正在读取页面正文…"));
    renderEmptyState();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : t("站点权限申请失败。"));
  }
}

async function activateCurrentPage() {
  if (activationNeeded?.reason === 'unsupported') {
    setNotice(t("当前页面不支持阅读，请切换到公开文章、文档或 GitHub 页面。"));
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
    setNotice(t("没有找到当前页面，请重新点击扩展按钮。"));
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: 'deep-research:activate-current-page', tabId }).catch(() => null);
  if (!result?.ok) setNotice(result?.error || t("当前页面无法启用阅读。"));
}

function handleEmptyPrimary() {
  if (!textModelReady()) {
    showModelSetupGuidance(readingMode === 'platform' ? t("平台 AI") : t("阅读"));
    return;
  }
  void activateCurrentPage();
}

function showSettings() {
  show($('page-view'), false); show($('empty-view'), false); show(ensureSaveDialog(), false); show(ensureAnnotationDialog(), false); show($('settings-view'), true); show($('reader-status-strip'), false); show($('settings-button'), true); document.querySelectorAll('.workspace-nav-item').forEach(button => button.setAttribute('aria-pressed', String(button.id === 'settings-button'))); applyProviderFields(); updateReadingModeUi();
}

function showModelSetupGuidance(action) {
  showSettings();
  const guidance = $('mode-guidance');
  if (!guidance) return;
  const nextStep = readingMode === 'platform'
    ? platformConnected
      ? t("平台已连接，请返回阅读后重试。")
      : t("连接调研平台并完成登录；无需配置本地模型。")
    : t("填写模型服务地址和 API Key，连接后选择模型；本地服务可不填 Key。也可切换到平台模式。");
  guidance.textContent = t("{0}尚未开始。{1}", action, nextStep);
  guidance.classList.add('is-warning');
  show(guidance, true);
}

function showReading() {
  closeProviderPicker();
  clearTimeout(modelDiscoveryTimer);
  modelDiscoveryController?.abort();
  if ($('model-discovery-status').dataset.state === 'loading') setDiscoveryState('idle', t("等待连接"));
  resetProviderValidation();
  $('provider-key').type = 'password';
  $('provider-key-toggle').setAttribute('aria-pressed', 'false');
  $('provider-key-toggle').setAttribute('aria-label', t("显示 API Key"));
  $('provider-key-toggle').title = t("显示 API Key");
  show($('settings-view'), false); show(ensureSaveDialog(), false); show(ensureAnnotationDialog(), false); show($('reader-status-strip'), true); show($('settings-button'), true); $('settings-button').setAttribute('aria-pressed', 'false'); setWorkspaceView(document.querySelector('.shell').dataset.workspaceView || 'chat'); renderPage(); updateLibrary();
}

async function openHistoryPage() {
  try {
    persistQuestionDraft();
    await sessionSaveQueue;
    window.location.href = chrome.runtime.getURL(`reading-history.html?surface=sidepanel${boundWindowTabId ? `&sourceTab=${boundWindowTabId}` : ''}`);
  } catch {
    setNotice(t("无法打开侧栏内的阅读历史。"));
  }
}

const consumedSelectionActions = new Set();
function handleSelectionAction(message) {
  if (message.actionId && consumedSelectionActions.has(message.actionId)) return;
  if (message.actionId) consumedSelectionActions.add(message.actionId);
  void chrome.storage.session.remove('readerPendingSelectionAction').catch(() => {});
  if (message.context?.selection?.quote) {
    interactionGeneration += 1;
    selectionContext = message.context;
    pageContext ||= message.context;
    discussionScope = 'selection';
    imageContext = null;
    renderPage();
  }
  if (message.action === 'translate' && selectionContext) {
    if (!textModelReady()) { showModelSetupGuidance(t("选段翻译")); return; }
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

async function restorePendingSelectionAction() {
  const stored = await chrome.storage.session.get('readerPendingSelectionAction');
  const pending = stored.readerPendingSelectionAction;
  if (!pending) return;
  if (Date.now() - pending.createdAt > 15000) { await chrome.storage.session.remove('readerPendingSelectionAction'); return; }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (pending.tabId !== (boundWindowTabId || tab?.id)) return;
  handleSelectionAction(pending);
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
  if (boundWindowTabId && Number.isInteger(message.tabId) && message.tabId !== boundWindowTabId) return;
  if (boundWindowTabId && message.type === 'deep-research:clear-page') return;
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
    if (activationNeeded.reason === 'permission') setNotice(t("此站点尚未启用；点击“启用此站点”后才会读取页面。"));
    return;
  }
  if (message.type === 'deep-research:connection-state') {
    platformStateEvents += 1;
    setPlatformConnected(Boolean(message.connected), message.connected ? t("已连接 · {0}", platformUrl) : (message.status || t("未连接")));
    return;
  }
  if (message.type === 'deep-research:clear-page') {
    detachCurrentAnswer();
    switchQuestionDraft();
    if (activeJobRecord?.id) chrome.runtime.sendMessage({ type: 'deep-research:translation-cancel', jobId: activeJobRecord.id }).catch(() => {});
    activeTranslationRun += 1; sessionGeneration += 1; sessionResumeTasks.clear(); activeJobRecord = null; pendingJob = null; failedTranslationItems = []; retryingTranslationId = null; pageContext = null; documentContext = null; selectionContext = null; imageContext = null; latestAnswer = ''; latestStructuredAnswer = null; latestAnswerContext = null; discussionHistory = []; discussionScope = 'page'; discussionIntent = 'ask'; discussionOpen = false; activeSessionTitle = ''; resumedUrls.clear(); activationNeeded = null; pageReadState = 'idle'; lastSavedInsight = null; pendingInsightSource = null; translationRequested = false; fullTranslationEnabled = false; translationPaused = false; translationRunning = false; radarEntryPlatformUrl = ''; radarEntryPromptKey = ''; radarEntrySummaryId = ''; radarEntryUrl = ''; translatedTextIds.clear(); translatedImageIds.clear(); sendToPage({ type: 'deep-research:clear-annotations' }); renderPage(); return;
  }
  if (message.type === 'deep-research:page-context' && message.context) {
    switchQuestionDraft(message.context.url);
    if (Number.isInteger(message.tabId)) activeTabId = message.tabId;
    if (activationNeeded) setNotice('');
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
      if (documentChanged || documentContextChanged) detachCurrentAnswer();
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
      if (documentChanged) {
        latestAnswer = '';
        latestStructuredAnswer = null;
        latestAnswerContext = null;
        discussionHistory = [];
        discussionScope = 'page';
        discussionIntent = 'ask';
        discussionOpen = false;
        activeSessionTitle = '';
      } else if (contentChanged) {
        latestAnswerContext = null;
        const scopeChanged = discussionScope !== 'page';
        if (scopeChanged) {
          discussionScope = 'page';
          discussionIntent = 'ask';
        }
        if (latestStructuredAnswer) {
          latestStructuredAnswer = {
            ...latestStructuredAnswer,
            evidence: [],
            warnings: [...new Set([
              ...(Array.isArray(latestStructuredAnswer.warnings) ? latestStructuredAnswer.warnings : []),
              t("页面内容已更新，旧引文定位已撤销。"),
            ])],
          };
        }
        setNotice(scopeChanged
          ? t("页面内容已变化；聊天记录已保留，旧引文定位已撤销，讨论范围已切换到整页。")
          : t("页面内容已变化；聊天记录已保留，旧引文定位已撤销。"));
      }
      if (documentChanged || contentChanged) resumedUrls.delete(message.context.url);
      failedTranslationItems = [];
      translatedTextIds.clear();
      translatedImageIds.clear();
      if (documentChanged) setNotice('');
    }
    applyRadarEntryContext(pageContext);
    renderPage(); setPlatformConnected(platformConnected); void applyAnnotationsForContext(pageContext);
    // Restore an exact page-version session before persisting the fresh page
    // snapshot. Otherwise the first page-context event could overwrite a
    // renamed session (and its discussion) with an empty default session.
    const contextForResume = pageContext;
    const interactionAtResumeStart = interactionGeneration;
    void (async () => {
      if (!contentChanged) await resumeSession(contextForResume);
      if (!discussionRunning) void resumeBackgroundAnswer(contextForResume);
      if (interactionAtResumeStart !== interactionGeneration || contextForResume !== pageContext) return;
      saveLocalSession();
      await findPendingTranslation(contextForResume);
    })();
    // When a page appends or edits content during a full translation, the
    // old overlays must be removed before taking the new snapshot. The
    // `translations-restored` event below is the single hand-off point that
    // starts the replacement job; doing it here as well creates a race where
    // the restore event cancels the just-started request.
    if (contentChanged && fullTranslationEnabled && !translationPaused && textModelReady()) {
      translationRequested = true;
      return;
    }
    if (fullTranslationEnabled && !translationPaused && !translationRunning && textModelReady() && Array.isArray(pageContext.blocks)) {
      const pendingBlocks = pageContext.blocks.filter((block) => block.kind !== 'code' && !translatedTextIds.has(block.id) && !pageContext.translatedBlockIds?.includes(block.id));
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
    translationPaused = Boolean(message.cancelled && translationPaused);
    renderProgress(activeJobRecord.textDone || 0, activeJobRecord.textTotal || 0, activeJobRecord.imageDone || 0, activeJobRecord.imageTotal || 0);
    const failures = failedTranslationItems.length;
    const workerWarnings = Array.isArray(message.warnings) ? message.warnings : (Array.isArray(activeJobRecord.warnings) ? activeJobRecord.warnings : []);
    const explicitCancellation = cancellationRequested || message.job?.error === t("用户取消了翻译");
    cancellationRequested = false;
    setNotice(message.cancelled
      ? (explicitCancellation
        ? t("翻译已取消，已完成内容保留。再次点击“全文翻译”可以继续。")
        : t("翻译已暂停。再次点击全文翻译会从本地缓存继续。"))
      : failures ? t("翻译完成，但有 {0} 项需要重试。{1}", failures, workerWarnings.length ? `\n${workerWarnings.slice(0, 3).join('\n')}` : '')
        : workerWarnings.length ? t("全文翻译完成。{0}", workerWarnings.slice(0, 3).join('\n')) : t("全文翻译完成。可以滚动阅读，或选择一段文字继续追问。"));
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
      discussionIntent = 'ask';
      if (discussionRunning) setNotice(t("选段已更新，将用于下一问；当前回答继续使用发起时的原文。"));
    }
    imageContext = null;
    selectionContext = message.context;
    discussionScope = 'selection';
    renderPage();
    saveLocalSession();
  }
  if (message.type === 'deep-research:image-action' && message.image) {
    if (discussionRunning) { setNotice(t("当前回答继续运行；完成后可解读图示。")); return; }
    selectionContext = null;
    imageContext = { ...(documentContext || pageContext || {}), image: message.image, restored: false };
    discussionScope = 'image';
    discussionIntent = 'explain';
    discussionOpen = true;
    renderPage();
    saveLocalSession();
    show($('discussion-section'), discussionOpen);
    renderDiscussionContext('image', 'explain', imageContext || pageContext);
  }
  if (message.type === 'deep-research:selection-action') handleSelectionAction(message);
  if (message.type === 'deep-research:page-action') {
    const pendingWrite = chrome.storage.session?.remove?.('readerPendingPageAction');
    pendingWrite?.catch?.(() => {});
    void handlePageAction(message.action);
  }
  if (message.type === 'deep-research:translations-restored') {
    if (activeJobRecord) persistJobPatch(activeJobRecord, { appliedTextIds: [] });
    if (pageContext) pageContext.translatedBlockIds = [];
    // A content mutation can invalidate the page version while the user is
    // still in full-translation mode. Preserve that intent and take a fresh
    // snapshot only after the old wrappers are gone. An explicit user restore
    // clears `fullTranslationEnabled` before sending this message, so it
    // still behaves as a true stop action.
    const resumeFullTranslation = Boolean(
      fullTranslationEnabled
      && translationRequested
      && !translationPaused
      && textModelReady()
      && pageContext?.url,
    );
    activeTranslationRun += 1;
    translationController?.abort();
    translatedTextIds.clear();
    translatedImageIds.clear();
    translationRunning = resumeFullTranslation;
    if (resumeFullTranslation) {
      translationController = new AbortController();
      setNotice(t("页面内容已更新，正在继续翻译新增正文和图片…"));
      void sendToPage({ type: 'deep-research:request-full-document' });
    } else {
      translationRequested = false;
      fullTranslationEnabled = false;
      translationPaused = false;
      setNotice(t("已恢复原文。"));
    }
    renderProgress();
  }
  if (message.type === 'deep-research:anchor-unresolved') {
    setNotice(message.reason || t("原文已变化，无法准确定位；没有跳转到相似段落。"));
  }
  if (message.type === 'deep-research:anchor-resolved') {
    setNotice(t("已回到原文证据。"));
  }
  if (message.type === 'deep-research:annotation-unresolved') {
    if (!pendingAnnotationHighlightId || message.id === pendingAnnotationHighlightId) {
      setNotice(message.reason || t("原文已变化，标注已保存，但没有高亮到不匹配的位置。"));
      pendingAnnotationHighlightId = null;
    }
  }
  if (message.type === 'deep-research:annotation-resolved' && message.id === pendingAnnotationHighlightId) {
    setNotice(t("标注已保存，并已在原文高亮。"));
    pendingAnnotationHighlightId = null;
  }
});

async function init() {
  setupWorkspaceLayout();
  webSearchEnabled = await readerStore.getSetting('webSearchEnabled', false) === true;
  renderWebSearchToggle();
  $('web-search-toggle').addEventListener('click', async () => {
    const button = $('web-search-toggle');
    const next = !webSearchEnabled;
    // Permissions must be requested synchronously within the user's click.
    const permission = next && !platformModeReady() ? chrome.permissions.request({ origins: SEARCH_ORIGINS }) : Promise.resolve(true);
    button.disabled = true;
    try {
      if (!await permission) { setNotice(t('未获得搜索站点权限，联网补充保持关闭。')); return; }
      await readerStore.setSetting('webSearchEnabled', next);
      webSearchEnabled = next; renderWebSearchToggle();
    } catch { setNotice(t('联网设置保存失败，请重试。')); }
    finally { button.disabled = false; }
  });
  setWorkspaceView(new URLSearchParams(location.search).get('view') || 'chat');
  $('question-input').addEventListener('input', () => { persistQuestionDraft(); renderWebSearchToggle(); });
  window.addEventListener('pagehide', persistQuestionDraft);
  $('question-input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); $('send-question').click(); }
  });
  provider = await loadProvider();
  translationLanguage = normalizeTranslationLanguage(await readerStore.getSetting('translationLanguage', 'interface'));
  updateTranslationLanguageUi();
  window.addEventListener('reader:translation-language-change', event => void changeTranslationLanguage(event.detail));

  readingMode = await readerStore.getSetting('readingMode', 'local');
  await syncSearchPermissions();
  applyProviderFields();
  await loadPlatformState();
  updateReadingModeUi();
  renderEmptyState();
  $('settings-button').addEventListener('click', showSettings); $('empty-settings').addEventListener('click', handleEmptyPrimary); $('empty-history')?.addEventListener('click', () => void openHistoryPage()); $('open-history-header')?.addEventListener('click', () => void openHistoryPage()); $('close-settings').addEventListener('click', showReading);
  $('mode-local')?.addEventListener('click', () => void setReadingMode('local'));
  $('mode-platform')?.addEventListener('click', () => void setReadingMode('platform'));
  $('ai-availability-action')?.addEventListener('click', () => showModelSetupGuidance(readingMode === 'platform' ? t("平台 AI") : t("阅读")));
  $('provider-kind')?.addEventListener('change', changeProviderKind);
  setupProviderPicker();
  $('stop-answer').addEventListener('click', () => discussionController?.abort());
  $('interface-language').value = (await chrome.storage.local.get('readerUiLanguage')).readerUiLanguage || 'system';
  $('interface-language').addEventListener('change', async event => {
    persistQuestionDraft();
    saveLocalSession();
    await sessionSaveQueue;
    await setUiLanguage(event.target.value);
    location.reload();
  });
  $('refresh-models').addEventListener('click', () => void refreshModels({ requestPermission: true }));
  $('provider-url').addEventListener('input', scheduleModelDiscovery);
  $('provider-key').addEventListener('input', scheduleModelDiscovery);
  $('provider-model-list').addEventListener('change', () => { $('provider-model').value = $('provider-model-list').value; providerFieldsDirty = true; resetProviderValidation(); });
  $('provider-model').addEventListener('input', () => { $('provider-model-list').value = ''; providerFieldsDirty = true; resetProviderValidation(); });
  $('provider-model-search').addEventListener('input', () => renderSettingsModels());
  $('provider-key-toggle').addEventListener('click', () => {
    const visible = $('provider-key').type === 'password';
    $('provider-key').type = visible ? 'text' : 'password';
    $('provider-key-toggle').setAttribute('aria-pressed', String(visible));
    $('provider-key-toggle').setAttribute('aria-label', visible ? t("隐藏 API Key") : t("显示 API Key"));
    $('provider-key-toggle').title = visible ? t("隐藏 API Key") : t("显示 API Key");
  });
  $('test-provider').addEventListener('click', () => void testSettingsProvider());
  $('test-vision').addEventListener('click', async () => {
    const button = $('test-vision'); button.disabled = true;
    let candidate = providerFromFields();
    try {
      candidate = validateModelConnection(candidate, { requireModel: true });
      if (!(await requestOriginPermission(candidate.baseUrl))) throw new ModelConnectionError('PERMISSION', t("未允许访问这个服务，图片能力检测尚未开始"));
      await testVisionProvider(candidate);
      if (!sameSettingsConnection(candidate, providerFromFields()) || candidate.model !== providerFromFields().model) return;
      provider = await saveProvider({ ...candidate, visionReady: true });
      providerFieldsDirty = false;
      setNotice(t("图片能力检测通过。"), $('settings-notice'));
    }
    catch (error) { showProviderError(error, candidate, $('provider-test-status')); }
    finally { button.disabled = false; }
  });
  $('chat-summary').addEventListener('click', () => void explainOrAsk('', activeDiscussionScope(), activeDiscussionScope() === 'selection' ? 'selection-summary' : 'summary'));
  $('chat-translate').addEventListener('click', () => activeDiscussionScope() === 'selection' ? void explainOrAsk('', 'selection', 'translate') : void startFullTranslation());
  $('save-settings').addEventListener('click', () => void saveSettings());
  $('pause-translation').addEventListener('click', () => {
    if (!translationRunning) { void startFullTranslation(); return; }
    translationPaused = true;
    cancellationRequested = false;
    if (activeJobRecord?.id) chrome.runtime.sendMessage({ type: 'deep-research:translation-cancel', jobId: activeJobRecord.id }).catch(() => {});
    translationController?.abort();
    renderProgress();
  });
  $('cancel-translation').addEventListener('click', cancelCurrentTranslation);
  $('restore-page').addEventListener('click', () => {
    activeTranslationRun += 1;
    cancellationRequested = false;
    if (activeJobRecord?.id) chrome.runtime.sendMessage({ type: 'deep-research:translation-cancel', jobId: activeJobRecord.id }).catch(() => {});
    persistJobPatch(activeJobRecord, { status: 'cancelled', error: t("用户恢复了原文") });
    translationController?.abort();
    translationRequested = false; fullTranslationEnabled = false; translationPaused = false; translationRunning = false;
    activeJobRecord = null; pendingJob = null; failedTranslationItems = [];
    translatedTextIds.clear(); translatedImageIds.clear();
    if (pageContext) pageContext = { ...pageContext, translatedBlockIds: [], translatedImageIds: [] };
    renderProgress();
    sendToPage({ type: 'deep-research:restore-translations' });
  });
  $('annotate-selection').addEventListener('click', () => void openAnnotationDialog());
  $('save-selection').addEventListener('click', () => void saveInsight());
  $('save-answer')?.addEventListener('click', () => void openSaveDialog());
  $('open-page-chat')?.addEventListener('click', () => openDiscussion('page', 'ask'));
  $('expand-chat')?.addEventListener('click', () => setChatExpanded(!$('page-view')?.classList.contains('chat-expanded')));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setChatExpanded(false);
  });
  $('open-history-inline')?.addEventListener('click', () => void openHistoryPage());
  $('scope-page')?.addEventListener('click', () => setDiscussionScope('page'));
  $('scope-selection')?.addEventListener('click', () => setDiscussionScope('selection'));
  $('scope-image')?.addEventListener('click', () => setDiscussionScope('image'));
  $('explain-image').addEventListener('click', () => void explainOrAsk('', 'image', 'explain'));
  $('clear-image').addEventListener('click', () => {
    imageContext = null;
    if (discussionScope === 'image') {
      discussionScope = 'page';
      discussionIntent = 'ask';
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
  $('continue-saved-discussion')?.addEventListener('click', () => {
    openDiscussion(activeDiscussionScope(), 'ask');
  });
  $('refresh-library').addEventListener('click', () => void updateLibrary());
  $('clear-cache').addEventListener('click', () => void readerStore.clearCache().then(() => setNotice(t("翻译缓存已清除。"), $('settings-notice')))); $('clear-data').addEventListener('click', async () => { if (!window.confirm(t("清除本地阅读会话、收藏、设置和缓存？导出数据不会受影响。"))) return; activeTranslationRun += 1; discussionController?.abort(); translationController?.abort(); translationRunning = false; translationRequested = false; fullTranslationEnabled = false; activeJobRecord = null; pendingJob = null; lastSavedInsight = null; await readerStore.clearAll(); webSearchEnabled = false; renderWebSearchToggle(); translationLanguage = 'interface'; updateTranslationLanguageUi(); await chrome.storage.local.remove(['readerToken', 'readerPlatformUrl']); provider = null; platformUrl = DEFAULT_WEB_APP_URL; updatePlatformTarget(); setPlatformConnected(false);  applyProviderFields(); setNotice(t("本地阅读数据已清除。"), $('settings-notice')); await updateLibrary(); }); $('export-data').addEventListener('click', () => void readerStore.exportData().then(downloadJson)); $('import-data').addEventListener('click', () => $('import-file').click()); $('import-file').addEventListener('change', async (event) => { const file = event.target.files?.[0]; if (!file) return; try { await readerStore.importData(JSON.parse(await file.text())); webSearchEnabled = await readerStore.getSetting('webSearchEnabled', false) === true; await syncSearchPermissions(); renderWebSearchToggle(); translationLanguage = normalizeTranslationLanguage(await readerStore.getSetting('translationLanguage', 'interface')); updateTranslationLanguageUi(); provider = await loadProvider();  platformUrl = resolvePlatformOrigin(await readerStore.getSetting('platformUrl', ''), radarEntryPlatformUrl); updatePlatformTarget(); await chrome.storage.local.set({ readerPlatformUrl: platformUrl }); applyProviderFields(); setNotice(t("阅读数据已导入。"), $('settings-notice')); await updateLibrary(); } catch (error) { setNotice(error instanceof SyntaxError ? t("导入文件不是有效的 JSON，请选择导出的阅读数据文件。") : error instanceof Error ? error.message : t("导入失败"), $('settings-notice')); } finally { event.target.value = ''; } });
  await updateLibrary();
  void restorePendingPageAction();
  void restorePendingSelectionAction();
  // The content script can report page context before React finishes loading
  // this controller. Re-request the active tab after all listeners are bound
  // so opening or recreating the side panel never leaves it blank.
  void activateCurrentPage();
  if (new URLSearchParams(location.search).get('view') === 'settings') showSettings();
  document.documentElement.dataset.readerReady = 'true';
}

void init();
