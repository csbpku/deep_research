import { boundTaskContext, loadProvider, makeDocument, mergeProcessedIds, mergeTranslationFailures, providerReady, translateBlocks, translateImage } from './reader-core.js';
import { readerStore } from './reader-store.js';
import { activationReason } from './activation.js';
import { DEFAULT_WEB_APP_URL, resolvePlatformOrigin } from './platform-config.js';

const CONTENT_SCRIPT = 'content.js';
const RESUME_ALARM = 'deep-research-reader-resume';
const READING_WINDOW_PREFIX = 'readingWindow:';
const translationJobs = new Map();
// A window enters reading mode only after the user has clicked the extension
// action once.  Keeping this state per window gives us a safe second stage:
// switching tabs while the panel is open can follow the user, but opening a
// random tab never grants the extension implicit access to its contents.
const readingWindows = new Set();

function readingWindowKey(windowId) {
  return `${READING_WINDOW_PREFIX}${windowId}`;
}

async function markReadingWindow(windowId) {
  if (!Number.isInteger(windowId)) return;
  readingWindows.add(windowId);
  try {
    if (chrome.storage.session?.set) await chrome.storage.session.set({ [readingWindowKey(windowId)]: true });
  } catch {
    // The in-memory marker is enough until the worker is restarted.
  }
}

async function isReadingWindow(windowId) {
  if (!Number.isInteger(windowId)) return false;
  if (readingWindows.has(windowId)) return true;
  try {
    const stored = await chrome.storage.session?.get(readingWindowKey(windowId));
    if (stored?.[readingWindowKey(windowId)]) {
      readingWindows.add(windowId);
      return true;
    }
  } catch {
    // Session storage is a convenience for worker restarts. The in-memory
    // marker remains the source of truth when it is unavailable.
  }
  return false;
}

function notifyPageActivationNeeded(tab, reason = activationReason(tab)) {
  return chrome.runtime.sendMessage({
    type: 'deep-research:page-activation-needed',
    tabId: tab?.id,
    windowId: tab?.windowId,
    url: tab?.url || '',
    reason,
  }).catch(() => {});
}

async function activateTabForReading(tab, { engageWindow = false } = {}) {
  if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
    return { ok: false, reason: 'unsupported' };
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT] });
    if (engageWindow) await markReadingWindow(tab.windowId);
    await chrome.tabs.sendMessage(tab.id, { type: 'deep-research:request-page' });
    return { ok: true, tabId: tab.id, windowId: tab.windowId };
  } catch (error) {
    const reason = activationReason(tab);
    await notifyPageActivationNeeded(tab, reason);
    console.warn('Deep Research could not activate this page', error);
    return {
      ok: false,
      reason,
      error: reason === 'unsupported'
        ? '当前页面受 Chrome 保护，扩展无法注入阅读助手。请切换到公开文章、文档或 GitHub 页面。'
        : reason === 'permission'
          ? '还没有启用当前站点。点击“启用此站点”后，Reader 才会读取页面正文。'
          : '暂时无法确认当前网页，请切换到普通网页后重试。',
    };
  }
}

function sendToTab(tabId, payload) {
  if (typeof tabId !== 'number') return Promise.resolve();
  return chrome.tabs.sendMessage(tabId, payload).catch(() => {});
}

function sendWorkerEvent(payload) {
  return chrome.runtime.sendMessage(payload).catch(() => {});
}

function patchJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  void readerStore.saveJob(job);
  return job;
}

function summarizeFailure(item, kind) {
  return {
    id: item.id,
    kind,
    label: item.sourceText?.slice(0, 96) || item.alt || item.src || item.id,
    error: item.error || item.note || '处理失败',
  };
}

async function executeTranslationJob({ jobId, tabId, context, reapply = false }) {
  const existing = translationJobs.get(jobId);
  if (existing) {
    existing.tabId = tabId;
    const nextHash = context?.contentHash || context?.version || null;
    const currentHash = existing.job?.contentHash || null;
    // A duplicate start for the same snapshot is harmless. A newer DOM
    // snapshot, however, must wait for the current request to unwind; simply
    // returning here loses the dynamic update because the side panel has
    // already sent its one full-document request.
    if (nextHash && currentHash && nextHash !== currentHash) {
      existing.pending = { tabId, context, reapply };
      existing.controller.abort();
    }
    return;
  }
  const controller = new AbortController();
  const boundedContext = boundTaskContext(context);
  // Reserve the job ID before any IndexedDB await so duplicate messages from
  // a recreated panel cannot start two model pipelines.
  translationJobs.set(jobId, { controller, tabId, job: null, pending: null });
  const persisted = await readerStore.getJob(jobId).catch(() => null);
  const job = {
    ...(persisted || {}),
    id: jobId,
    documentUrl: boundedContext.url,
    contentHash: boundedContext.contentHash || boundedContext.version || null,
    kind: 'text',
    status: 'queued',
    textDone: Number.isFinite(Number(persisted?.textDone)) ? Number(persisted.textDone) : 0,
    textTotal: Math.max(Number(persisted?.textTotal) || 0, Array.isArray(boundedContext.blocks) ? boundedContext.blocks.length : 0),
    imageDone: Number.isFinite(Number(persisted?.imageDone)) ? Number(persisted.imageDone) : 0,
    imageTotal: Math.max(Number(persisted?.imageTotal) || 0, Array.isArray(boundedContext.images) ? boundedContext.images.length : 0),
    failedItems: Array.isArray(persisted?.failedItems) ? persisted.failedItems : [],
    processedTextIds: Array.isArray(persisted?.processedTextIds) ? persisted.processedTextIds : [],
    processedImageIds: Array.isArray(persisted?.processedImageIds) ? persisted.processedImageIds : [],
    workerManaged: true,
    inputReady: false,
    recoveryRequired: false,
    error: null,
    tabId,
  };
  translationJobs.set(jobId, { controller, tabId, job });
  // Commit the recoverable job before storing its (potentially large) input.
  // If MV3 suspends the worker between these awaits, the next alarm/startup
  // can still see a queued job and decide whether it is safe to resume.
  await readerStore.saveJob(job);
  // Keep the potentially large page/image input in its own temporary store.
  // Progress writes therefore stay small, and terminal tasks do not become a
  // second permanent copy of the document.
  await readerStore.saveTaskInput(jobId, boundedContext);
  // Mark the hand-off complete only after the temporary input is durable. A
  // worker that stops between the two writes is therefore distinguishable from
  // a recoverable queued task and will be reported explicitly on startup.
  job.inputReady = true;
  await readerStore.saveJob(job);
  const emit = (type, extra = {}) => void sendWorkerEvent({ type, jobId, tabId, ...extra });
  try {
    const provider = await loadProvider();
    if (!providerReady(provider)) throw new Error('本地模型配置已失效，请重新打开设置测试连接');
    const readingProvider = {
      ...provider,
      language: boundedContext.targetLanguage || provider.language || 'zh-CN',
    };
    const document = makeDocument(boundedContext);
    const blocks = Array.isArray(boundedContext.blocks) ? boundedContext.blocks : [];
    const images = Array.isArray(boundedContext.images) ? boundedContext.images : [];
    const translatableBlocks = blocks.filter((block) => block.kind !== 'code');
    const skippedCodeBlocks = blocks.length - translatableBlocks.length;
    const blockIds = blocks.map((block) => block.id).filter(Boolean);
    const imageIds = images.map((image) => image.id).filter(Boolean);
    patchJob(job, {
      status: 'running',
      textDone: Math.max(Number(job.textDone) || 0, job.processedTextIds.length),
      textTotal: Math.max(Number(job.textTotal) || 0, new Set([...job.processedTextIds, ...blockIds]).size),
      imageDone: Math.max(Number(job.imageDone) || 0, job.processedImageIds.length),
      imageTotal: Math.max(Number(job.imageTotal) || 0, new Set([...job.processedImageIds, ...imageIds]).size),
      reapply,
    });
    emit('deep-research:translation-progress', { progress: { ...job } });

    const translations = await translateBlocks(readingProvider, document, translatableBlocks, {
      signal: controller.signal,
      // The content script can paint a paragraph as soon as its model call
      // completes. The final aggregate below remains as a recovery pass for
      // a page that changed while the job was running.
      onResult: (item) => {
        if (!item?.text) return;
        return sendToTab(tabId, { type: 'deep-research:apply-translations', translations: [item] });
      },
      onProgress: (done) => {
        patchJob(job, {
          textDone: Math.max(Number(job.textDone) || 0, done + skippedCodeBlocks),
          textTotal: Math.max(Number(job.textTotal) || 0, new Set([...job.processedTextIds, ...blockIds]).size),
        });
        emit('deep-research:translation-progress', { progress: { ...job } });
      },
    });
    job.processedTextIds = mergeProcessedIds(job.processedTextIds, [
      ...translations.filter((item) => item.text || item.error).map((item) => item.id),
      ...blocks.filter((block) => block.kind === 'code').map((block) => block.id),
    ]);
    const usableTranslations = translations.filter((item) => item.text);
    if (usableTranslations.length) await sendToTab(tabId, { type: 'deep-research:apply-translations', translations: usableTranslations });

    const imageTranslations = [];
    for (const image of images) {
      if (controller.signal.aborted) throw new DOMException('翻译已取消', 'AbortError');
      try {
        imageTranslations.push(await translateImage(readingProvider, document, image, { signal: controller.signal, fetchImageBytes: true }));
      } catch (error) {
        imageTranslations.push({ ...image, regions: [], confidence: 0, note: error instanceof Error ? error.message : '图片翻译失败' });
      }
      job.processedImageIds = mergeProcessedIds(job.processedImageIds, [image.id]);
      patchJob(job, {
        imageDone: Math.max(Number(job.imageDone) || 0, job.processedImageIds.length),
        imageTotal: Math.max(Number(job.imageTotal) || 0, new Set([...job.processedImageIds, ...imageIds]).size),
      });
      emit('deep-research:translation-progress', { progress: { ...job } });
    }
    const usableImageTranslations = imageTranslations.filter((item) => item.regions?.length || item.fallbackText || item.fallbackRegions?.length);
    if (usableImageTranslations.length) await sendToTab(tabId, { type: 'deep-research:apply-image-translations', translations: usableImageTranslations });
    const currentFailures = translations.filter((item) => item.error).map((item) => summarizeFailure(item, 'text'));
    currentFailures.push(...imageTranslations.filter((item) => !item.regions?.length && !item.fallbackText && !item.noText && !item.keptOriginal).map((item) => summarizeFailure(item, 'image')));
    const resolvedIds = [
      ...translations.filter((item) => item.text).map((item) => item.id),
      ...imageTranslations.filter((item) => item.regions?.length || item.fallbackText || item.noText || item.keptOriginal).map((item) => item.id),
    ].filter(Boolean);
    const failures = mergeTranslationFailures(job.failedItems, currentFailures, resolvedIds);
    const warnings = [
      ...(boundedContext.taskWarnings || []),
      ...imageTranslations.filter((item) => item.noText || item.keptOriginal || item.sourceWarning || (item.fallbackText && item.note)).map((item) => `图片 ${item.id}: ${[item.sourceWarning, item.noText ? '未发现可可靠读取的文字' : '', item.keptOriginal ? '图片文字为技术标识符，保留原文' : '', item.note].filter(Boolean).join('；')}`),
    ];
    patchJob(job, {
      status: failures.length ? 'completed_with_errors' : 'completed',
      textDone: Math.max(Number(job.textDone) || 0, job.processedTextIds.length),
      textTotal: Math.max(Number(job.textTotal) || 0, new Set([...job.processedTextIds, ...blockIds]).size),
      imageDone: Math.max(Number(job.imageDone) || 0, job.processedImageIds.length),
      imageTotal: Math.max(Number(job.imageTotal) || 0, new Set([...job.processedImageIds, ...imageIds]).size),
      failedItems: failures,
      warnings,
      completedAt: new Date().toISOString(),
      tabId: undefined,
      inputReady: false,
      recoveryRequired: false,
    });
    await readerStore.deleteTaskInput(jobId);
    emit('deep-research:translation-complete', { job: { ...job }, failures, warnings });
  } catch (error) {
    const recoverForNewPage = Boolean(translationJobs.get(jobId)?.preserveForRecovery);
    const cancelled = error instanceof DOMException && error.name === 'AbortError';
    patchJob(job, {
      status: recoverForNewPage ? 'queued' : (cancelled ? 'cancelled' : 'failed'),
      error: recoverForNewPage ? '原网页标签页已关闭，重新打开同一页面后将继续翻译' : (error instanceof Error ? error.message : '全文翻译失败'),
      tabId: undefined,
      inputReady: recoverForNewPage,
      recoveryRequired: recoverForNewPage,
    });
    if (!recoverForNewPage) await readerStore.deleteTaskInput(jobId);
    emit('deep-research:translation-complete', { job: { ...job }, failures: job.failedItems || [], cancelled: !recoverForNewPage && cancelled });
  } finally {
    const active = translationJobs.get(jobId);
    const pending = active?.pending;
    translationJobs.delete(jobId);
    if (pending) {
      // Let the terminal write and task-input cleanup commit before starting
      // the queued snapshot with the same durable job id. This keeps failure
      // history and processed IDs available to the incremental run.
      queueMicrotask(() => void executeTranslationJob({ jobId, ...pending }));
    }
  }
}

function cancelTranslationJob(jobId, { preserveForRecovery = false } = {}) {
  const active = translationJobs.get(jobId);
  if (active) {
    active.preserveForRecovery = preserveForRecovery;
    active.controller.abort();
    return;
  }
  void readerStore.getJob(jobId).then((job) => {
    if (job && ['queued', 'running'].includes(job.status)) {
      if (preserveForRecovery) {
        void readerStore.saveJob({
          ...job,
          status: 'queued',
          error: '原网页标签页已关闭，重新打开同一页面后将继续翻译',
          tabId: undefined,
          inputReady: true,
          recoveryRequired: true,
          updatedAt: new Date().toISOString(),
        });
      } else {
        patchJob(job, { status: 'cancelled', error: '用户取消了翻译', tabId: undefined, inputReady: false, recoveryRequired: false });
        void readerStore.deleteTaskInput(jobId);
      }
    }
  });
}

function cancelTranslationJobsForTab(tabId, options = {}) {
  translationJobs.forEach((active, jobId) => {
    if (active.tabId === tabId) cancelTranslationJob(jobId, options);
  });
}

function cancelTranslationJobsExceptTab(tabId) {
  translationJobs.forEach((active, jobId) => {
    if (active.tabId !== tabId) cancelTranslationJob(jobId);
  });
}

async function resumePersistedTranslationJobs() {
  const jobs = await readerStore.listJobs().catch(() => []);
  for (const job of jobs) {
    if (['completed', 'completed_with_errors', 'cancelled', 'failed', 'stale'].includes(job.status)) {
      // A crash can happen after the terminal job write and before the
      // temporary page input is deleted. Clean that disposable copy on the
      // next worker start without touching the user's durable reading data.
      void readerStore.deleteTaskInput(job.id);
      continue;
    }
    if (!['queued', 'running'].includes(job.status)) continue;
    const taskContext = await readerStore.getTaskInput(job.id).catch(() => null);
    if (!taskContext) {
      const textComplete = Number(job.textTotal) > 0 && Number(job.textDone) >= Number(job.textTotal);
      const imageComplete = Number(job.imageTotal) === 0 || Number(job.imageDone) >= Number(job.imageTotal);
      if (textComplete && imageComplete) {
        // The browser can close just after the worker writes its final
        // progress and just before the disposable input delete commits. The
        // counters are durable evidence that this is a completed job, not a
        // lost input. Recover the terminal state and let the next startup
        // perform the harmless cleanup.
        await readerStore.saveJob({
          ...job,
          status: Array.isArray(job.failedItems) && job.failedItems.length ? 'completed_with_errors' : 'completed',
          error: null,
          tabId: undefined,
          inputReady: false,
          recoveryRequired: false,
          completedAt: job.completedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        continue;
      }
      await readerStore.saveJob({
        ...job,
        status: 'failed',
        error: '翻译任务的临时正文已丢失，请重新打开页面后重试',
        tabId: undefined,
        inputReady: false,
        recoveryRequired: false,
        updatedAt: new Date().toISOString(),
      });
      continue;
    }
    if (job.inputReady === false) {
      await readerStore.saveJob({
        ...job,
        status: 'failed',
        error: '翻译任务在保存临时正文前中断，请重新开始',
        tabId: undefined,
        recoveryRequired: false,
        updatedAt: new Date().toISOString(),
      });
      await readerStore.deleteTaskInput(job.id);
      continue;
    }
    if (!Number.isInteger(job.tabId)) continue;
    try {
      await chrome.tabs.get(job.tabId);
      void executeTranslationJob({ jobId: job.id, tabId: job.tabId, context: taskContext });
    } catch {
      // The source tab may have disappeared while the browser was restoring a
      // session. Keep the input and make the job recoverable when the user
      // opens the same URL again; do not silently discard the only context.
      await readerStore.saveJob({
        ...job,
        status: 'queued',
        error: '原网页标签页暂不可用，重新打开同一页面后将继续翻译',
        tabId: undefined,
        recoveryRequired: true,
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

async function cancelPersistedJobsForTab(tabId) {
  const jobs = await readerStore.listJobs().catch(() => []);
  for (const job of jobs) {
    if (job.tabId !== tabId || !['queued', 'running'].includes(job.status)) continue;
    await readerStore.saveJob({
      ...job,
      status: 'queued',
      error: '原网页标签页已关闭，重新打开同一页面后可以继续翻译',
      tabId: undefined,
      recoveryRequired: true,
      updatedAt: new Date().toISOString(),
    });
  }
}

void resumePersistedTranslationJobs();
chrome.runtime.onStartup?.addListener(() => { void resumePersistedTranslationJobs(); });

// MV3 workers may be suspended while a provider request is in flight.  The
// durable job plus task-input records make resumption idempotent; an alarm is
// the wake-up path when the browser starts the worker again without a new
// side-panel message.
async function ensureResumeAlarm() {
  if (!chrome.alarms?.create) return;
  try {
    await chrome.alarms.create(RESUME_ALARM, { periodInMinutes: 0.5 });
  } catch {
    // Older Chromium builds may reject a sub-minute period.  Startup and the
    // next user action still provide a safe recovery path in that case.
  }
}

void ensureResumeAlarm();
chrome.runtime.onStartup?.addListener(() => { void ensureResumeAlarm(); });
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === RESUME_ALARM) void resumePersistedTranslationJobs();
});

async function webAppUrl() {
  const stored = await chrome.storage.local.get(['readerPlatformUrl']);
  const value = typeof stored.readerPlatformUrl === 'string' ? stored.readerPlatformUrl.trim() : '';
  return resolvePlatformOrigin(value);
}

function base64Url(bytes) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function makePkce() {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64Url(raw);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)), state: base64Url(crypto.getRandomValues(new Uint8Array(16))) };
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined || tab.windowId === undefined) return;

  // Chrome requires sidePanel.open() to run synchronously in the action's
  // user-gesture handler. Calling it after an awaited script injection loses
  // that gesture and leaves the page injected but the panel closed.
  const panelOpen = chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
    console.warn('Deep Research could not open the side panel', error);
  });
  void panelOpen;
  void activateTabForReading(tab, { engageWindow: true });
});

// A side panel is scoped to a window, while its content is scoped to the
// active tab. Clear stale evidence immediately when the user changes tabs.
// Injection on the new tab is the second, explicit stage of startup: it runs
// only for a window that the user already engaged with the toolbar action and
// never requests a new host permission from a background event.
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void (async () => {
    if (!(await isReadingWindow(windowId))) return;
    cancelTranslationJobsExceptTab(tabId);
    chrome.runtime.sendMessage({ type: 'deep-research:clear-page' }).catch(() => {});
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const activation = await activateTabForReading(tab);
    if (!activation.ok) return;
    chrome.storage.session.get([`readerContext:${tabId}`]).then((stored) => {
      const context = stored[`readerContext:${tabId}`];
      if (context) chrome.runtime.sendMessage({ ...context, tabId, windowId }).catch(() => {});
    }).catch(() => {});
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab?.active || !Number.isInteger(tab.windowId)) return;
  void (async () => {
    if (!(await isReadingWindow(tab.windowId))) return;
    await activateTabForReading(tab);
  })();
});

chrome.windows?.onRemoved?.addListener((windowId) => {
  readingWindows.delete(windowId);
  chrome.storage.session?.remove?.(readingWindowKey(windowId)).catch?.(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelTranslationJobsForTab(tabId, { preserveForRecovery: true });
  void cancelPersistedJobsForTab(tabId);
  // Page context is intentionally session-only. Remove orphaned tab entries
  // immediately instead of waiting for the browser session to end.
  chrome.storage.session.remove(`readerContext:${tabId}`).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'deep-research:open-panel') {
    const tab = sender.tab;
    if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
      sendResponse?.({ ok: false, reason: 'unsupported' });
      return false;
    }
    try {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    } catch {
      // The click originated in the content script, but older Chromium
      // versions may still reject sidePanel.open. The toolbar action remains
      // available as a fallback.
    }
    void activateTabForReading(tab, { engageWindow: true });
    sendResponse?.({ ok: true });
    return false;
  }
  if (message?.type === 'deep-research:activate-current-page') {
    const requestedTabId = Number.isInteger(message.tabId) ? message.tabId : sender.tab?.id;
    if (!Number.isInteger(requestedTabId)) {
      sendResponse?.({ ok: false, reason: 'unsupported', error: '没有找到当前页面' });
      return false;
    }
    chrome.tabs.get(requestedTabId).then((tab) => activateTabForReading(tab, { engageWindow: true }))
      .then((result) => sendResponse?.(result))
      .catch((error) => sendResponse?.({ ok: false, reason: activationReason({}), error: error instanceof Error ? error.message : '页面无法启用阅读' }));
    return true;
  }
  if (message?.type === 'deep-research:translation-start') {
    const jobId = typeof message.jobId === 'string' ? message.jobId : '';
    const tabId = Number.isInteger(message.tabId) ? message.tabId : sender.tab?.id;
    if (!jobId || !message.context?.url || !Number.isInteger(tabId)) {
      sendResponse?.({ ok: false, error: '翻译任务缺少页面上下文' });
      return false;
    }
    void executeTranslationJob({ jobId, tabId, context: message.context, reapply: Boolean(message.reapply) });
    sendResponse?.({ ok: true });
    return true;
  }
  if (message?.type === 'deep-research:translation-cancel') {
    if (typeof message.jobId === 'string') cancelTranslationJob(message.jobId);
    sendResponse?.({ ok: true });
    return true;
  }
  if (message?.type === 'deep-research:connect') {
    Promise.all([makePkce(), webAppUrl()]).then(async ([pkce, baseUrl]) => {
      const { verifier, challenge, state } = pkce;
      const redirect = chrome.runtime.getURL('callback.html');
      await chrome.storage.session.set({ readerPkce: { verifier, state, redirect } });
      const url = `${baseUrl}/reading/connect?redirect=${encodeURIComponent(redirect)}&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&state=${encodeURIComponent(state)}`;
      await chrome.tabs.create({ url });
      sendResponse?.({ ok: true });
    }).catch((error) => {
      sendResponse?.({ ok: false, message: error instanceof Error ? error.message : '无法打开平台授权页' });
    });
    return true;
  }
  if (message?.type === 'deep-research:disconnect') {
    chrome.storage.local.remove('readerToken').then(() => {
      chrome.runtime.sendMessage({ type: 'deep-research:connection-state', connected: false, status: '已断开平台连接' }).catch(() => {});
    }).catch(() => {});
    return;
  }
  if (message?.type === 'deep-research:exchange-code') {
    const code = typeof message.code === 'string' ? message.code : '';
    const state = typeof message.state === 'string' ? message.state : '';
    if (!code || !state) {
      sendResponse?.({ ok: false, message: '授权参数无效，请重新连接' });
      return false;
    }
    Promise.all([chrome.storage.session.get(['readerPkce']), webAppUrl()]).then(async ([{ readerPkce }, baseUrl]) => {
      if (!readerPkce || readerPkce.state !== state || !readerPkce.verifier || !readerPkce.redirect) {
        throw new Error('授权状态无效或已过期，请重新连接');
      }
      const response = await fetch(`${baseUrl}/api/reading/token/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, redirect: readerPkce.redirect, code_verifier: readerPkce.verifier }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.token) throw new Error(payload.message || '授权交换失败');
      await chrome.storage.local.set({ readerToken: payload.token });
      await chrome.storage.session.remove('readerPkce');
      chrome.runtime.sendMessage({ type: 'deep-research:connection-state', connected: true }).catch(() => {});
      sendResponse?.({ ok: true });
    }).catch((error) => {
      const failure = error instanceof Error ? error.message : '平台授权失败，请重新连接';
      chrome.runtime.sendMessage({
        type: 'deep-research:connection-state',
        connected: false,
        status: failure,
      }).catch(() => {});
      console.warn('Deep Research authorization exchange failed', error);
      sendResponse?.({ ok: false, message: failure });
    });
    return true;
  }
  if (message?.type === 'deep-research:from-page') {
    const pageTabId = sender.tab?.id;
    const pagePayload = message.payload;
    if (pageTabId !== undefined && (
      pagePayload?.type === 'deep-research:page-context'
      || pagePayload?.type === 'deep-research:selection'
    )) {
      // Side-panel documents can be recreated while the worker is idle. Keep
      // only the current tab's transient context in session storage; it is
      // cleared by tab switches and never enters the product database.
      chrome.storage.session.set({ [`readerContext:${pageTabId}`]: pagePayload }).catch(() => {});
    }
    const forwarded = {
      type: message.payload?.type || 'deep-research:selection',
      ...message.payload,
      tabId: sender.tab?.id,
      windowId: sender.tab?.windowId,
    };
    // Opening the native panel is best-effort.  In automation or after the
    // panel is already open, Chrome may leave that Promise pending because the
    // message no longer carries a toolbar user gesture.  The page context must
    // still be forwarded immediately; otherwise clicking a figure appears to
    // do nothing and the image discussion scope is lost.
    if (message.payload?.type === 'deep-research:image-action' && sender.tab?.windowId !== undefined) {
      try {
        chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
      } catch {
        // Some Chromium builds throw synchronously when the gesture is stale.
      }
    }
    chrome.runtime.sendMessage(forwarded).catch(() => {});
    return;
  }
  if (message?.type === 'deep-research:selection-action') {
    if (sender.tab?.windowId !== undefined) chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'deep-research:selection-action', action: message.action }).catch(() => {});
    return;
  }
  if (message?.type === 'deep-research:page-action') {
    const action = typeof message.action === 'string' ? message.action : '';
    if (!action) return;
    const pending = {
      action,
      tabId: Number.isInteger(sender.tab?.id) ? sender.tab.id : null,
      windowId: Number.isInteger(sender.tab?.windowId) ? sender.tab.windowId : null,
      createdAt: Date.now(),
    };
    const pendingWrite = chrome.storage.session?.set?.({ readerPendingPageAction: pending });
    pendingWrite?.catch?.(() => {});
    if (sender.tab?.windowId !== undefined) chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'deep-research:page-action', ...pending }).catch(() => {});
    return;
  }
  if (message?.type === 'deep-research:to-page') {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, message.payload).catch(() => {});
    }).catch(() => {});
  }
});
