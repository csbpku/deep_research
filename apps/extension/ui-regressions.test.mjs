import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import nodeVm from 'node:vm';
import { applyTextTranslations, mergeTranslationFailures, responseLanguageInstruction, translationBatches } from './reader-core.js';
import { answerTaskPresentation } from './answer-task.js';
import { readerStore } from './reader-store.js';
const t = (message, ...values) => message.replace(/\{(\d+)\}/gu, (_, index) => String(values[index] ?? ''));
const vm = {
  ...nodeVm,
  createContext: sandbox => nodeVm.createContext(Object.assign(sandbox, { t, responseLanguageInstruction, currentTranslationLanguage: sandbox.currentTranslationLanguage || sandbox.currentReadingLanguage || (() => 'zh-CN'), updateTranslationLanguageUi: () => {} })),
  runInNewContext: (source, sandbox, options) => nodeVm.runInNewContext(source, Object.assign(sandbox, { t, responseLanguageInstruction, currentTranslationLanguage: sandbox.currentTranslationLanguage || sandbox.currentReadingLanguage || (() => 'zh-CN'), updateTranslationLanguageUi: () => {} }), options),
};
const panel = readFileSync(new URL('./sidepanel.js', import.meta.url), 'utf8');
const content = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
function extract(source, start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

test('page status refresh retains action-specific model setup guidance until configured', () => {
  const nodes = {};
  const sandbox = {
    $: id => nodes[id] ||= { classList: { remove() {}, add() {}, toggle() {} }, setAttribute() {} },
    readingMode: 'local', platformConnected: false, lastSavedInsight: null, insightSyncFailed: false,
    contextUrl: () => '', provider: {}, providerReady: () => sandbox.ready,
    textModelReady: () => sandbox.ready, ready: false,
    show() {}, setStatus() {}, updateAiAvailabilityBanner() {},
    showSettings() { sandbox.updateReadingModeUi(); },
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(panel, "let modelSetupAction = '';", 'async function setReadingMode(')
    + extract(panel, 'function showModelSetupGuidance(', 'function showReading('), sandbox);
  vm.runInContext("showModelSetupGuidance('全文总结')", sandbox);
  assert.match(nodes['mode-guidance'].textContent, /全文总结尚未开始/);
  vm.runInContext('updateReadingModeUi()', sandbox);
  assert.match(nodes['mode-guidance'].textContent, /全文总结尚未开始/);
  sandbox.ready = true;
  vm.runInContext('updateReadingModeUi()', sandbox);
  assert.equal(vm.runInContext('modelSetupAction', sandbox), '');
});

test('selection explain waits for panel initialization and runs exactly once', () => {
  const calls = [];
  const removed = [];
  const sandbox = {
    selectionActionsReady: false, queuedSelectionAction: null, interactionGeneration: 0,
    pageContext: null, selectionContext: null,
    chrome: { storage: { session: { remove: async key => removed.push(key) } } },
    renderPage() {}, explainOrAsk: (...args) => calls.push(args),
    message: { actionId: 'selection-action-1', action: 'explain', context: { url: 'https://article.test', selection: { quote: 'Selected text' } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(panel, 'const consumedSelectionActions =', 'async function restorePendingSelectionAction('), sandbox);
  vm.runInContext('handleSelectionAction(message)', sandbox);
  assert.equal(calls.length, 0);
  assert.equal(removed.length, 0);
  assert.equal(sandbox.queuedSelectionAction, sandbox.message);
  sandbox.selectionActionsReady = true;
  vm.runInContext('handleSelectionAction(queuedSelectionAction); handleSelectionAction(message)', sandbox);
  assert.deepEqual(calls, [['', 'selection', 'explain']]);
  assert.equal(removed.length, 1);
});

test('cross-paragraph selection retains the exact original slice for platform validation', async () => {
  const body = 'First paragraph.\n\nSecond paragraph.';
  const sandbox = {
    window: { getSelection: () => ({ toString: () => body, rangeCount: 0 }) },
    Node: { ELEMENT_NODE: 1 }, removeSelectionTranslation() {}, isTranslationNode: () => false,
    pageContext: () => ({ body, url: 'https://article.test' }), contentHash: async () => 'a'.repeat(64),
    selectorPathForSelection: () => null, sectionForSelection: () => body, sectionTitleForSelection: () => '',
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(content, '  function clean(', '  function stableNodeId(')
    + extract(content, '  function findQuoteRange(', '  function extractBlocks(')
    + extract(content, '  async function selectionContext(', '  function removeSelectionToolbar('), sandbox);
  const result = await vm.runInContext('selectionContext()', sandbox);
  assert.equal(result.selection.quote, body.slice(result.selection.startOffset, result.selection.endOffset));
  assert.equal(result.selection.quote, body);
});

test('platform selection validation errors keep actionable context and request id', async () => {
  const { platformAnswerErrorMessage } = await import('./platform-answer.js');
  const message = platformAnswerErrorMessage({ code: 'VALIDATION_FAILED', message: '原文摘录与锚点位置不一致，请重新选择原文', requestId: 'request-anchor' }, 400);
  assert.match(message, /重新选择原文/);
  assert.match(message, /request-anchor/);
  assert.doesNotMatch(message, /平台 AI 暂时无法完成/);
  assert.match(platformAnswerErrorMessage({}, 401), /重新连接平台/);
  assert.match(platformAnswerErrorMessage({ message: 'invalid_api_key' }, 401), /模型服务鉴权失败/);
  assert.match(platformAnswerErrorMessage({ message: 'insufficient_balance' }, 400), /模型额度不足/);
});

test('a failed quick action retains its question in chat without adding model history', () => {
  const rendered = [];
  const nodes = {};
  const sandbox = {
    $: id => nodes[id] ||= {}, failedQuestion: '解释当前选段', discussionHistory: [], discussionRunning: false,
    renderMaterialConversation: (_host, messages) => rendered.push(...messages),
    show: (node, visible) => { node.visible = visible; },
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(panel, 'function renderConversation(', 'function renderEmptyState('), sandbox);
  vm.runInContext('renderConversation()', sandbox);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].content, '解释当前选段');
  assert.equal(nodes['conversation-empty'].visible, false);
  assert.equal(sandbox.discussionHistory.length, 0);
});

test('selection actions open the native side panel without awaiting its promise', () => {
  const background = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const opener = extract(background, "    if (['deep-research:image-action'", '    // Inactive articles still emit');
  let opened = 0;
  vm.runInNewContext(opener, {
    message: { payload: { type: 'deep-research:selection-action', action: 'explain' } },
    sender: { tab: { windowId: 7 } },
    chrome: { sidePanel: { open: ({ windowId }) => { assert.equal(windowId, 7); opened++; return new Promise(() => {}); } } },
  });
  assert.equal(opened, 1);
});

test('platform output-limit failures retain their cause and either request-id spelling', () => {
  const source = readFileSync(new URL('./platform-answer.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(extract(source, 'export function platformAnswerErrorMessage(', '\n// end').replace('export ', ''), sandbox);
  for (const key of ['request_id', 'requestId']) {
    sandbox.payload = { code: 'AI_RESPONSE_TRUNCATED', [key]: 'request-123' };
    const result = vm.runInContext('platformAnswerErrorMessage(payload)', sandbox);
    assert.match(result, /输出上限/);
    assert.match(result, /request-123/);
    assert.doesNotMatch(result, /联系平台管理员/);
  }
});

test('answer recovery separates quick-action labels, typed drafts and legacy internal prompts', async () => {
  const prompt = 'Internal summary instructions: use four Markdown sections and evidence cards.';
  const cases = [
    { status: 'failed', question: '总结本页', prompt, initial: prompt, expected: '' },
    { status: 'interrupted', question: '总结本页', prompt, initial: '', expected: '' },
    { status: 'failed', question: '总结本页', prompt, initial: 'My next question', expected: 'My next question' },
    { status: 'failed', question: 'Why a queue?', prompt: 'Why a queue?', initial: '', expected: 'Why a queue?' },
    { status: 'failed', userMessage: '总结本页', intent: 'summary', draft: '', initial: '', expected: '' },
    { status: 'running', question: '总结本页', prompt, initial: '', expected: '' },
  ];
  for (const item of cases) {
    const input = { value: item.initial };
    const labels = [];
    const sandbox = { answerTaskPresentation, discussionRunning: false, discussionSubscription: null, AbortController,
      chrome: { runtime: { sendMessage: async () => item } }, contextUrl: () => 'https://article.test',
      $: () => input, persistQuestionDraft: () => {}, setNotice: () => {}, renderPage: () => labels.push(sandbox.pendingAnswer?.userMessage),
      renderPersistentComposer: () => {}, revealPendingAnswer: () => {}, renderPendingAnswer: () => {},
      waitForAnswerTask: async () => { throw new DOMException('Detached', 'AbortError'); },
    };
    vm.createContext(sandbox);
    vm.runInContext(extract(panel, 'async function resumeBackgroundAnswer(', 'async function explainOrAsk('), sandbox);
    await vm.runInContext("resumeBackgroundAnswer({url:'https://article.test'})", sandbox);
    assert.equal(input.value, item.expected);
    assert.ok(labels.every(label => label === '总结本页'));
  }
});

test('new background answer snapshots omit model instructions and retain only display labels and typed drafts', async () => {
  const source = readFileSync(new URL('./answer-worker.js', import.meta.url), 'utf8');
  for (const intent of ['summary', 'ask']) {
    const stored = [];
    let listener;
    const sandbox = { tasks: new Map(), AbortController, key: id => id, execute: () => {},
      chrome: { runtime: { id: 'test', getURL: () => 'chrome-extension://test/', onMessage: { addListener: fn => { listener = fn; } } },
        storage: { session: { set: async value => stored.push(value) } } },
    };
    vm.runInNewContext(source.slice(source.indexOf('chrome.runtime.onMessage.addListener(')), sandbox);
    listener({ type: 'deep-research:answer-start', input: { id: 'job', context: { url: 'https://article.test' }, history: [], intent,
      userMessage: intent === 'summary' ? '总结本页' : 'My actual question', question: 'Internal model instruction' } },
    { id: 'test', url: 'chrome-extension://test/sidepanel.html' }, () => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!('prompt' in stored[0].job));
    assert.equal(stored[0].job.draft, intent === 'ask' ? 'My actual question' : '');
  }
});

test('translation progress counts confirmed page translations instead of processed model blocks', () => {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, style: {}, setAttribute(name, value) { this[name] = value; } });
    return nodes.get(id);
  };
  const sandbox = { $, activeJobRecord: { textDone: 410, textTotal: 410, status: 'completed' }, pageContext: { translatedBlockIds: [] },
    translationRunning: false, translationPaused: false, translationRequested: true, fullTranslationEnabled: true,
    failedTranslationItems: [], translatedTextIds: new Set(), translatedImageIds: new Set(), readingMode: 'platform',
    show: () => {}, renderTranslationFailures: () => {}, activeDiscussionScope: () => 'page',
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(panel, 'function renderProgress(', 'function renderTranslationFailures('), sandbox);
  vm.runInContext('renderProgress()', sandbox);
  assert.equal($('text-progress-value').textContent, '0 / 410');
  assert.equal($('translation-summary').dataset.state, 'error');
  assert.equal($('text-progress-bar').style.width, '0%');
  sandbox.activeJobRecord = { textDone: 3, textTotal: 3, appliedTextIds: ['a', 'b'], skippedTextIds: ['code'], status: 'completed' };
  vm.runInContext('renderProgress()', sandbox);
  assert.equal($('text-progress-value').textContent, '2 / 2');
  assert.equal($('translation-summary').dataset.state, 'completed');
});

test('section traversal terminates through nested trailing containers and stops at peer heading', () => {
  const node = (tagName, text) => ({ tagName, innerText: text, nodeType: 1, closest: () => null });
  const heading = node('H2', 'First');
  const paragraph = node('P', 'Selected');
  const nested = node('DIV', '');
  const tail = node('P', 'Nested tail');
  const next = node('H2', 'Second');
  const nodes = [heading, paragraph, nested, tail, next];
  const container = { querySelectorAll: () => [heading, next] };
  for (const h of [heading, next]) h.contains = () => false;
  heading.compareDocumentPosition = () => 4;
  next.compareDocumentPosition = () => 0;
  paragraph.parentElement = { closest: () => container };
  heading.parentElement = { nextElementSibling: nested };
  heading.nextElementSibling = paragraph;
  paragraph.nextElementSibling = nested;
  const sandbox = { root: container, Node: { ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4 }, NodeFilter: { SHOW_ELEMENT: 1 }, clean: (s) => s.trim(), selection: { anchorNode: paragraph }, document: { createTreeWalker: () => ({ currentNode: null, nextNode() { this.currentNode = nodes[nodes.indexOf(this.currentNode) + 1]; return this.currentNode; } }) } };
  assert.equal(vm.runInNewContext(`${extract(content, '  function sectionForSelection(', '  function sectionTitleForSelection(')}\nsectionForSelection(selection)`, sandbox, { timeout: 100 }), 'First\n\nSelected\n\nNested tail');
});

test('unsent drafts stay with their page across clear and revisit', () => {
  const input = { value: '' };
  const sandbox = { Map, $: () => input };
  vm.createContext(sandbox);
  vm.runInContext(extract(panel, 'const questionDrafts =', 'let sessionGeneration ='), sandbox);
  vm.runInContext("switchQuestionDraft('https://a.test');", sandbox);
  input.value = 'Question about A';
  vm.runInContext("switchQuestionDraft(); switchQuestionDraft('https://b.test');", sandbox);
  assert.equal(input.value, '');
  input.value = 'Question about B';
  vm.runInContext("switchQuestionDraft('https://a.test');", sandbox);
  assert.equal(input.value, 'Question about A');
});

function translationSandbox(context, imageRequest) {
  const controller = new AbortController();
  const job = { id: 'job', textDone: 0, textTotal: 0, imageDone: 0, imageTotal: 0 };
  const notices = [];
  const sandbox = {
    DOMException, context, boundWindowTabId: null, activeTabId: 7, applyTextTranslations, translationController: controller, activeJobRecord: job,
    translationRequested: true, translationRunning: true, activeTranslationRun: 1,
    failedTranslationItems: [], translatedTextIds: new Set(), translatedImageIds: new Set(),
    platformModeReady: () => true, boundTaskContext: (c) => c, currentReadingLanguage: () => 'zh-CN',
    updatePageContextUi: () => {}, updateReaderTranslations: () => {}, translationCoverageWarning: () => '', makeDocument: (c) => c,
    persistJobPatch: (j, p) => Object.assign(j, p), renderProgress: () => {}, sendToPage: async (m) => ({ ok: true, appliedIds: (m.translations || []).map(item => item.id) }),
    setNotice: (n) => notices.push(n), requestPlatformTranslations: async () => [],
    requestPlatformImageTranslation: async (...args) => imageRequest(controller, ...args),
    mergeProcessedIds: (a, b) => [...new Set([...a, ...b])],
    mergeTranslationFailures: (_a, b) => b, renderTranslationFailures: () => {}, saveLocalSession: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(panel, 'async function processDocument(', 'const FULL_PAGE_SUMMARY_PROMPT'), sandbox);
  return { sandbox, job, notices };
}

test('pause during image request retains pending image without false failure', async () => {
  const { sandbox, job, notices } = translationSandbox({ url: 'https://a.test', blocks: [], images: [{ id: 'image-0' }] }, async (controller) => {
    controller.abort();
    throw new Error('signal is aborted without reason');
  });
  await vm.runInContext('processDocument(context, 1)', sandbox);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.imageDone, 0);
  assert.equal(sandbox.failedTranslationItems.length, 0);
  assert.match(notices.at(-1), /已暂停/);
  assert.equal(sandbox.translationRunning, false);
});

test('selection completion describes actual translation scope', async () => {
  const { sandbox, notices } = translationSandbox({ url: 'https://a.test', scope: 'selection', blocks: [], images: [] }, () => {});
  await vm.runInContext('processDocument(context, 1)', sandbox);
  assert.match(notices.at(-1), /^选段翻译完成/);
  assert.doesNotMatch(notices.at(-1), /全文翻译完成/);
});

test('background page updates cannot replace the visible tab context', async () => {
  const background = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const forwarding = extract(background, '    // Inactive articles still emit', "  if (message?.type === 'deep-research:selection-action')").replace(/\s*return;\s*\}\s*$/u, '');
  for (const [pageTabId, expected] of [[7, 1], [9, 0]]) {
    const sent = [];
    const sandbox = { pageTabId, sender: { tab: { windowId: 2 } }, forwarded: { context: 'article' }, chrome: {
      tabs: { query: async () => [{ id: 7 }] }, runtime: { sendMessage: async (m) => { sent.push(m); } },
    } };
    vm.runInNewContext(forwarding, sandbox);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, expected);
  }
});

test('platform stream rejects truncated and missing completion instead of saving partial answers', async () => {
  for (const frame of [
    'event: done\ndata: {"truncated":true,"reading":{"answer":"half a sentence"}}\n\n',
    'event: done\ndata: {"finishReason":"length","reading":{"answer":"half a sentence"}}\n\n',
    'event: delta\ndata: {"text":"half a sentence"}\n\n',
  ]) {
    let emitted = false;
    const sandbox = {
      readingAnswerText: (text) => text, TextDecoder, scope: 'page', sourceContext: { url: 'https://a.test', title: 'Article', body: 'Source' }, discussionHistory: [], platformUrl: 'https://platform.test',
      platformContext: (c) => c,
      chrome: { storage: { local: { get: async () => ({ readerToken: 'test' }) } } },
      fetch: async () => ({ ok: true, body: { getReader: () => ({ read: async () => {
        if (emitted) return { done: true };
        emitted = true;
        return { done: false, value: new TextEncoder().encode(frame) };
      } }) } }),
    };
    vm.createContext(sandbox);
    vm.runInContext(extract(readFileSync(new URL('./platform-answer.js', import.meta.url), 'utf8'), 'export async function requestPlatformAnswer(', 'export function platformAnswerErrorMessage(').replace('export ', ''), sandbox);
    await assert.rejects(vm.runInContext("requestPlatformAnswer(sourceContext, 'question', scope, { platformUrl: 'https://platform.test', history: [] })", sandbox), /未保存为完整结论/);
  }
});

test('macOS Option letter symbols still trigger selection shortcuts; editors remain excluded', () => {
  let listener;
  let actions = [];
  const source = extract(content, "  document.addEventListener('keydown', (event) => {", '  function showSelectionToolbar(');
  const sandbox = { document: { addEventListener: (_type, fn) => { listener = fn; } }, toolbarHost: null,
    isTypingTarget: (target) => target === 'editor', lastSelectionContext: { selection: { quote: 'selected' } },
    send: (message) => actions.push(message), removeSelectionToolbar: () => {},
  };
  vm.runInNewContext(source, sandbox);
  listener({ key: 'Í', code: 'KeyS', altKey: true, shiftKey: true, preventDefault() {} });
  assert.equal(actions.at(-1).action, 'summary');
  actions = [];
  listener({ key: 'Í', code: 'KeyS', altKey: true, shiftKey: true, target: 'editor', preventDefault() {} });
  assert.equal(actions.length, 0);
});


test('Escape closes selection translation even when focus is outside its shadow root', () => {
  const handler = extract(content, "  document.addEventListener('keydown', (event) => {", '  function showSelectionToolbar(');
  let listener;
  let closed = 0;
  vm.runInNewContext(handler, {
    document: { addEventListener: (_type, callback) => { listener = callback; }, querySelector: () => null },
    removeSelectionTranslation: () => { closed += 1; }, toolbarHost: null,
  });
  listener({ key: 'Escape' });
  assert.equal(closed, 1);
});

test('duplicate saved insight explicitly updates the cloud and reports unsupported servers as unsynced', async () => {
  for (const updateOk of [true, false]) {
    const methods = [];
    const notices = [];
    const sandbox = {
      chrome: { storage: { local: { get: async () => ({ readerToken: 'test', readerTokenOrigin: 'https://platform.test' }) } } },
      tokenBoundToOrigin: (a, b) => a === b,
      platformUrl: 'https://platform.test', insightSyncFailed: false,
      platformConnected: true, platformDisconnecting: false, platformStateEvents: 0,
      normalizeRadarSummaryId: readerStore.normalizeRadarSummaryId,
      updatePageKnowledge: () => {},
      updateReadingModeUi: () => {}, setNotice: (n) => notices.push(n),
      fetch: async (_url, request) => {
        methods.push(request.method);
        return request.method === 'POST'
          ? { ok: true, json: async () => ({ deduplicated: true }) }
          : { ok: updateOk, json: async () => updateOk ? { updated: true } : {} };
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(extract(panel, 'async function readPlatformToken(', 'async function connectPlatform(') + extract(panel, 'async function syncInsight(', 'async function syncCurrentSession('), sandbox);
    await vm.runInContext("syncInsight({ id: 'saved-id', url: 'https://source.test', title: 'Source', quote: 'Quote', note: 'Edited' })", sandbox);
    assert.deepEqual(methods, ['POST', 'PUT']);
    assert.equal(sandbox.insightSyncFailed, !updateOk);
    assert.match(notices.at(-1), updateOk ? /已更新/ : /云端尚未更新/);
  }
});

test('saving freezes radar and version at capture; editing never borrows the current radar or anchor', async () => {
  const radarId = '30000000-0000-4000-8000-000000000001';
  const originalRadarId = '30000000-0000-4000-8000-000000000002';
  for (const editing of [false, true, 'with-radar']) {
    let visibleUrl = 'https://save-source.test/original';
    const saved = [];
    const fields = new Map();
    const $ = id => {
      if (!fields.has(id)) fields.set(id, { value: '', focus() {} });
      return fields.get(id);
    };
    const original = { id: 'old-insight', url: visibleUrl, title: 'Original', quote: 'Source quote',
      document: { url: visibleUrl, version: editing ? null : 'v1' },
      ...(editing === 'with-radar' ? { radarSummaryId: originalRadarId } : {}) };
    const sandbox = {
      $, readingMode: 'local', editingInsight: null, pendingInsightSource: null, platformStateEvents: 0, saveDialogGeneration: 0, saveOptions: {}, pageContext: null, documentContext: null,
      platformConnected: false, platformDisconnecting: false, selectionContext: null,
      latestAnswerSource: () => original, currentRadarSummaryId: () => radarId, contextUrl: () => visibleUrl,
      normalizeRadarSummaryId: readerStore.normalizeRadarSummaryId,
      readerStore: { ...readerStore, saveInsight: async item => { saved.push(item); return { ...item, id: item.id || 'new-insight' }; } },
      ensureSaveDialog: () => ({}), ensureAnnotationDialog: () => ({}), show() {}, setNotice() {},
      platformModeReady: () => false, readPlatformToken: async () => '', showReading() {}, updateLibrary: async () => {},
      updateSaveOptions: options => { sandbox.saveOptions = options; }, applyAnnotationsForContext: async () => {},
    };
    vm.createContext(sandbox);
    vm.runInContext(extract(panel, 'async function openSaveDialog(', 'function saveInsight('), sandbox);
    sandbox.input = editing ? original : null;
    await vm.runInContext('openSaveDialog(input)', sandbox);
    visibleUrl = 'https://save-source.test/unrelated';
    sandbox.selectionContext = { url: visibleUrl, contentHash: 'unrelated-v9', selection: { quote: original.quote, contentHash: 'unrelated-v9' } };
    await vm.runInContext('confirmSaveInsight()', sandbox);
    assert.equal(saved[0].url, original.url);
    assert.equal(saved[0].document.version, editing ? null : 'v1');
    assert.equal(saved[0].anchor, undefined);
    assert.equal(saved[0].radarSummaryId, editing === 'with-radar' ? originalRadarId : editing ? undefined : radarId);
  }
});

test('insight sync sends only the saved valid radar and retains returned draft identity and origin', async () => {
  const draftId = '40000000-0000-4000-8000-000000000001';
  for (const radarSummaryId of [draftId, 'not-a-uuid', undefined]) {
    const requests = [];
    const links = [];
    const sandbox = {
      platformUrl: 'https://platform.test', platformConnected: true, platformDisconnecting: false, platformStateEvents: 0,
      lastSavedInsight: { id: 'local' }, readPlatformToken: async () => 'bound-token',
      normalizeRadarSummaryId: readerStore.normalizeRadarSummaryId,
      updateReadingModeUi() {}, updatePageKnowledge() {}, setNotice() {},
      readerStore: { linkInsightToPlatform: async (...args) => { links.push(args); return { id: 'local', platformResearchId: args[1], platformOrigin: args[2] }; } },
      fetch: async (url, request) => { requests.push([url, JSON.parse(request.body)]); return { ok: true, json: async () => ({ draft: { id: draftId } }) }; },
      input: { id: 'local', url: 'https://source.test', quote: 'Evidence', radarSummaryId },
    };
    vm.createContext(sandbox);
    vm.runInContext(extract(panel, 'async function syncInsight(', 'async function syncCurrentSession('), sandbox);
    await vm.runInContext('syncInsight(input)', sandbox);
    assert.equal(requests[0][1].radarSummaryId, radarSummaryId === draftId ? draftId : undefined);
    assert.equal(Object.hasOwn(requests[0][1], 'radarSummaryId'), radarSummaryId === draftId);
    assert.deepEqual(links, [['local', draftId, 'https://platform.test']]);
    assert.equal(sandbox.lastSavedInsight.platformResearchId, draftId);
  }
});

test('disconnect during a deduplicated save prevents PUT and late platform identity writes', async () => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const calls = [];
  const sandbox = {
    platformUrl: 'https://platform.test', platformConnected: true, platformDisconnecting: false, platformStateEvents: 0,
    readPlatformToken: async () => 'token', normalizeRadarSummaryId: readerStore.normalizeRadarSummaryId,
    updateReadingModeUi() {}, setNotice() {}, fetch: async (_url, request) => { calls.push(request.method); return response; },
    readerStore: { linkInsightToPlatform: async () => { throw new Error('must not write after disconnect'); } },
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(panel, 'async function syncInsight(', 'async function syncCurrentSession('), sandbox);
  const work = vm.runInContext("syncInsight({id:'local',url:'https://source.test',quote:'Evidence'})", sandbox);
  await new Promise(resolve => setImmediate(resolve));
  sandbox.platformConnected = false;
  sandbox.platformStateEvents++;
  release({ ok: true, json: async () => ({ deduplicated: true }) });
  await work;
  assert.deepEqual(calls, ['POST']);
});

test('same-page recall is offline while disconnected and rejects late results after page or connection changes', async () => {
  for (const transition of ['offline', 'page', 'disconnect', 'connected']) {
    let release;
    const response = new Promise(resolve => { release = resolve; });
    const rendered = [];
    const calls = [];
    let visibleUrl = 'https://recall-source.test/article?utm_source=radar#intro';
    const sandbox = {
      pageKnowledgeKey: '', pageKnowledgeRequest: 0, pageKnowledgeController: null,
      documentContext: null, pageContext: { contentHash: 'v1' }, selectionContext: null,
      platformUrl: 'https://platform.test', platformConnected: transition !== 'offline', platformDisconnecting: false, platformStateEvents: 0,
      contextUrl: () => visibleUrl, normalizePlatformOrigin: value => value, AbortController, AbortSignal,
      renderPageKnowledge: items => rendered.push(items),
      readPlatformToken: async () => 'bound-token',
      readerStore: { ...readerStore, listPageKnowledge: async (_url, options) => options.platformItems || [{ id: 'local', note: 'Confirmed' }] },
      fetch: async (url, request) => { calls.push({ url, request }); return response; },
    };
    vm.createContext(sandbox);
    vm.runInContext(extract(panel, 'async function updatePageKnowledge(', 'async function findPendingTranslation('), sandbox);
    const work = vm.runInContext('updatePageKnowledge()', sandbox);
    await new Promise(resolve => setImmediate(resolve));
    if (transition === 'page') visibleUrl = 'https://recall-source.test/other';
    if (transition === 'disconnect') { sandbox.platformConnected = false; sandbox.platformStateEvents++; }
    release({ ok: true, json: async () => ({ items: [{ id: 'remote', note: 'Confirmed remote' }] }) });
    await work;
    if (transition === 'offline') assert.equal(calls.length, 0);
    else {
      assert.equal(calls.length, 1);
      assert.equal(new URL(calls[0].url).searchParams.get('url'), 'https://recall-source.test/article?utm_source=radar#intro');
      assert.equal(calls[0].request.cache, 'no-store');
    }
    assert.equal(rendered.some(items => items.some(item => item.id === 'remote')), transition === 'connected');
  }
});

test('session restoration recovers explicit radar without a chat and rejects unrelated or stale anchors', async () => {
  const radarId = '50000000-0000-4000-8000-000000000001';
  for (const mode of ['radar-only', 'stale', 'switched']) {
    const messages = [];
    const url = 'https://restore-source.test/article';
    const session = { url, radarSummaryId: radarId, ...(mode === 'stale' ? {
      stale: true, version: 'old', answer: 'Historical answer', answerStructured: { answer: 'Historical answer', evidence: [{ quote: 'Old evidence' }] },
      selection: { quote: 'Old evidence' }, pendingEvidenceAnchor: { quote: 'Old evidence' }, discussionScope: 'selection',
    } : {}) };
    const sandbox = {
      readerStore: { ...readerStore, markSessionsStale: async () => {}, getReadingSession: async () => session },
      resumedUrls: new Set(), sessionResumeTasks: new Map(), sessionGeneration: 0, interactionGeneration: 0,
      contextUrl: () => mode === 'switched' ? 'https://restore-source.test/unrelated' : url,
      consumePendingSession: async () => null, context: { url, contentHash: 'current' },
      selectionContext: null, radarEntrySummaryId: '', radarEntryUrl: '', imageContext: null, DISCUSSION_INTENTS: new Set(['ask']),
      renderPage() {}, sendToPage: message => messages.push(message), setNotice() {},
    };
    vm.createContext(sandbox);
    vm.runInContext(extract(panel, 'function normalizeRadarSummaryId(', 'function applyRadarEntryContext(')
      + extract(panel, 'async function resumeSession(', 'async function consumePendingSession('), sandbox);
    await vm.runInContext('resumeSession(context)', sandbox);
    assert.equal(sandbox.radarEntrySummaryId, mode === 'switched' ? '' : radarId);
    if (mode === 'stale') {
      assert.equal(sandbox.latestStructuredAnswer.evidence.length, 0);
      assert.equal(sandbox.selectionContext, null);
      assert.equal(sandbox.discussionScope, 'page');
      assert.equal(messages.some(message => message.type === 'deep-research:focus-anchor'), false);
      assert.equal(messages.find(message => message.type === 'deep-research:restore-progress').anchor, null);
    }
  }
});


test('platform translation resumes completed batches without requesting them again', async () => {
  const context = { url: 'https://a.test', blocks: [{ id: 'a', text: 'First' }, { id: 'b', text: 'Second' }], images: [] };
  const { sandbox, job } = translationSandbox(context, () => {});
  const batches = [];
  sandbox.requestPlatformTranslations = async (_context, blocks, options) => {
    batches.push(blocks.map((b) => b.id));
    const translated = { ...blocks[0], sourceText: blocks[0].text, text: '译文' };
    await options.onResult(translated);
    options.onProgress(1);
    if (batches.length === 1) {
      sandbox.translationController.abort();
      throw new DOMException('Paused', 'AbortError');
    }
    return [translated];
  };
  await vm.runInContext('processDocument(context, 1)', sandbox);
  assert.equal(job.textTranslations.length, 1);
  assert.deepEqual(Array.from(job.processedTextIds), ['a']);
  sandbox.translationController = new AbortController();
  sandbox.translationRunning = true;
  await vm.runInContext('processDocument(context, 1)', sandbox);
  assert.deepEqual(batches.map((ids) => Array.from(ids)), [['a', 'b'], ['b']]);
  assert.equal(job.textDone, 2);
  assert.equal(job.status, 'completed');
});

test('changing translation language does not reuse cached or displayed output in the old language', async () => {
  const context = { full: true, url: 'https://a.test', blocks: [{ id: 'a', text: 'First paragraph' }], images: [],
    translatedBlockIds: ['a'], displayedTranslationLanguage: 'en' };
  const { sandbox, job } = translationSandbox(context, () => {});
  Object.assign(job, { targetLanguage: 'en', textTranslations: [{ id: 'a', sourceText: 'First paragraph', text: 'First paragraph' }] });
  const requests = [];
  sandbox.requestPlatformTranslations = async (_context, blocks, options) => {
    requests.push(...blocks.map(block => block.id));
    const result = { id: 'a', sourceText: blocks[0].text, text: '第一段' };
    await options.onResult(result);
    options.onProgress(1);
    return [result];
  };
  await vm.runInContext('processDocument(context, 1)', sandbox);
  assert.deepEqual(requests, ['a']);
  assert.equal(job.targetLanguage, 'zh-CN');
  assert.equal(job.textTranslations[0].text, '第一段');
  assert.deepEqual(Array.from(job.appliedTextIds), ['a']);
});


test('workspace navigation selects one view and composer resize is bounded and keyboard accessible', () => {
  const shell = { dataset: {}, classList: { toggle() {} } };
  const location = { href: 'chrome-extension://reader/sidepanel.html?view=library&sourceTab=42' };
  const nodes = new Map();
  for (const id of ['nav-chat', 'nav-tools', 'nav-library', 'open-wide-window', 'composer-resize', 'question-input']) {
    nodes.set(id, { handlers: {}, attributes: {}, style: {}, classList: { toggle: () => {}, add: () => {} },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; },
      getClientRects() { return [{}]; },
      scrollHeight: 60,
      getBoundingClientRect() { return { height: Number.parseInt(this.style.height || '80', 10) }; },
    });
  }
  const sandbox = {
    document: { querySelector: () => shell, addEventListener() {} }, $: (id) => nodes.get(id),
    window: { innerHeight: 900, addEventListener() {}, history: { replaceState(_state, _title, url) { location.href = url; } } }, localStorage: { getItem: () => null, setItem: () => {} },
    URL, location,
    boundWindowTabId: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(panel, 'function setWorkspaceView(', 'function show('), sandbox);
  vm.runInContext("setWorkspaceView('library'); setupWorkspaceLayout();", sandbox);
  assert.equal(shell.dataset.workspaceView, 'library');
  assert.equal(nodes.get('nav-library').attributes['aria-pressed'], 'true');
  assert.equal(nodes.get('nav-chat').attributes['aria-pressed'], 'false');
  vm.runInContext("setWorkspaceView('chat')", sandbox);
  assert.equal(new URL(location.href).searchParams.has('view'), false);
  assert.equal(new URL(location.href).searchParams.get('sourceTab'), '42');
  const handle = nodes.get('composer-resize');
  const key = (value) => handle.handlers.keydown({ key: value, preventDefault() {} });
  key('End');
  assert.equal(nodes.get('question-input').style.height, '240px');
  key('Home');
  key('ArrowUp');
  assert.equal(nodes.get('question-input').style.height, '76px');
  assert.equal(handle.attributes['aria-valuenow'], '76');
  const input = nodes.get('question-input');
  input.scrollHeight = 320;
  input.handlers.input();
  assert.equal(input.style.height, '76px', 'manual size must not be overridden by long input');
  input.scrollHeight = 60;
  input.handlers.input();
  assert.equal(input.style.height, '76px', 'automatic growth preserves the manual preferred height');
});

test('source messages target the bound article instead of the extension tab', async () => {
  const background = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const handler = extract(background, "  if (message?.type === 'deep-research:to-page')", '\n});');
  const sent = [];
  const sandbox = {
    message: { type: 'deep-research:to-page', tabId: 42, payload: { type: 'deep-research:request-page' } },
    sender: { url: 'chrome-extension://test/sidepanel.html?sourceTab=42' }, sendResponse: () => {},
    chrome: { runtime: { getURL: (path) => `chrome-extension://test/${path}` }, tabs: {
      sendMessage: async (id, payload) => sent.push([id, payload.type]),
      query: () => { throw new Error('Must not query the popup as current article'); },
    } },
  };
  vm.runInNewContext(`(function () { ${handler} })()`, sandbox);
  assert.deepEqual(sent, [[42, 'deep-research:request-page']]);
});

test('source navigation keeps chat in place and targets the original article', () => {
  const sent = [];
  const sandbox = { sendToPage: (message) => sent.push(message) };
  vm.createContext(sandbox);
  vm.runInContext(extract(panel, 'function focusReadingAnchor(', 'function setWorkspaceView('), sandbox);
  vm.runInContext("focusReadingAnchor({quote:'original evidence'}); focusReadingAnchor(null)", sandbox);
  assert.equal(sent[0].type, 'deep-research:focus-anchor');
  assert.equal(sent[0].anchor.quote, 'original evidence');
  assert.equal(sent[1].type, 'deep-research:focus-page');
});

test('the sidebar has no popup entry or duplicated article reader', () => {
  const ui = readFileSync(new URL('./entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /open-wide-window|article-reader|reader-to-chat/);
  assert.doesNotMatch(panel, /chrome\.windows\.create|wide-workspace/);
});


test('source block extraction excludes nested translations and stays stable when hidden', () => {
  let translated = false;
  const node = {};
  node.cloneNode = () => { const clone = { textContent: translated ? 'Original原文译文' : 'Original' }; clone.querySelectorAll = () => translated ? [{ remove: () => { clone.textContent = 'Original'; } }] : []; return clone; };
  const sandbox = { clean: (text) => text.trim(), node };
  const fn = extract(content, '  function sourceBlockText(', '  function extractBlocks(');
  assert.equal(vm.runInNewContext(fn + '\nsourceBlockText(node)', sandbox), 'Original');
  translated = true;
  assert.equal(vm.runInNewContext(fn + '\nsourceBlockText(node)', sandbox), 'Original');
});


test('copy selection uses the current original quote and never the answer', async () => {
  let copied = '';
  const button = { textContent: '复制选段' };
  const sandbox = {
    selectionContext: { selection: { quote: 'Original selected passage.' } },
    activeDiscussionScope: () => 'selection',
    navigator: { clipboard: { writeText: async text => { copied = text; } } },
    $: () => button, window: { setTimeout() {} }, setNotice() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(panel, 'async function copyCurrentSelection(', 'function setNotice('), sandbox);
  await vm.runInContext('copyCurrentSelection()', sandbox);
  assert.equal(copied, 'Original selected passage.');
  assert.equal(button.textContent, '已复制');
  sandbox.activeDiscussionScope = () => 'page'; copied = '';
  await vm.runInContext('copyCurrentSelection()', sandbox);
  assert.equal(copied, '');
});


test('paragraph context menu toggles the clicked page without opening chat or starting a task', () => {
  const background = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const sent = []; let handler; let opens = 0;
  const sandbox = { chrome: { contextMenus: { onClicked: { addListener(fn) { handler = fn; } } }, sidePanel: { open() { opens++; return Promise.resolve(); } } }, sendToTab: (id, payload) => { sent.push([id, payload.type]); return Promise.resolve(); } };
  vm.createContext(sandbox);
  vm.runInContext(extract(background, 'chrome.contextMenus?.onClicked.addListener(', 'chrome.action.onClicked.addListener('), sandbox);
  handler({ menuItemId: 'reader:toggle-paragraph', frameId: 0 }, { id: 12, windowId: 3 });
  assert.deepEqual(sent, [[12, 'deep-research:toggle-paragraph']]);
  assert.equal(opens, 0);
  handler({ menuItemId: 'reader:toggle-paragraph', frameId: 5 }, { id: 12, windowId: 3 });
  assert.equal(sent.length, 1, 'a subframe cannot toggle an unrelated top-page paragraph');
});

test('paragraph menu updates in message order and hiding preserves its direction', () => {
  const background = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const updates = [];
  const sandbox = { chrome: { contextMenus: { update(id, properties) { updates.push({ id, ...properties }); } } } };
  vm.createContext(sandbox);
  const branch = extract(background, "if (pagePayload?.type === 'deep-research:paragraph-menu') {", 'if (pageTabId !== undefined && (');
  const update = vm.runInContext(`(function(pagePayload, sender) { const pageTabId = sender.tab?.id; ${branch} })`, sandbox);
  const active = { tab: { id: 12, active: true }, frameId: 0 };
  update({ type: 'deep-research:paragraph-menu', available: true, showingTranslation: true }, active);
  update({ type: 'deep-research:paragraph-menu', available: false, showingTranslation: false }, active);
  update({ type: 'deep-research:paragraph-menu', available: true, showingTranslation: false }, active);
  assert.deepEqual(updates.map(p => [p.visible, p.title]), [[true, '查看这一段原文'], [false, undefined], [true, '查看这一段译文']]);
  update({ type: 'deep-research:paragraph-menu', available: true, showingTranslation: true }, { tab: { id: 13, active: false }, frameId: 0 });
  update({ type: 'deep-research:paragraph-menu', available: true, showingTranslation: true }, { ...active, frameId: 3 });
  assert.equal(updates.length, 3, 'inactive tabs and subframes cannot overwrite the top-page menu');
});

test('a second translation start during the job-record read is queued instead of dropped', async () => {
  const background = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const start = background.indexOf('async function executeTranslationJob(');
  const end = background.indexOf('  // Commit the recoverable job', start);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const translationJobs = new Map();
  const sandbox = {
    translationJobs, AbortController, DOMException,
    boundTaskContext: (context) => context,
    mergeTranslationFailures,
    readerStore: { getJob: async () => { await gate; return null; }, saveJob: async () => { throw new Error('stop'); } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${background.slice(start, end)}\n  throw new Error('stop');\n}`, sandbox);
  const first = vm.runInContext("executeTranslationJob({ jobId: 'j', tabId: 1, context: { url: 'u', contentHash: 'a' } }).catch(() => {})", sandbox);
  const entry = translationJobs.get('j');
  await vm.runInContext("executeTranslationJob({ jobId: 'j', tabId: 1, context: { url: 'u', contentHash: 'b' } })", sandbox);
  entry.preserveForRecovery = true;
  release();
  await first;
  assert.equal(translationJobs.get('j'), entry, 'entry is mutated in place, not replaced');
  assert.equal(entry.pending?.context.contentHash, 'b');
  assert.equal(entry.preserveForRecovery, true);
  assert.ok(entry.job, 'job assigned after the await');
  assert.equal(entry.controller.signal.aborted, true);
});

test('platform translation keeps at most six requests in flight', async () => {
  const source = readFileSync(new URL('./sidepanel.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function requestPlatformTranslations(');
  const end = source.indexOf('async function requestPlatformImageTranslation(', start);
  assert.ok(start > 0 && end > start, 'requestPlatformTranslations is present');

  let inFlight = 0;
  let peak = 0;
  const blocks = Array.from({ length: 240 }, (_, index) => ({
    id: `block-${index}`, sourceBlockId: `block-${index}`, text: `原文 ${index}`, partCount: 1, kind: 'text',
  }));

  const sandbox = {
    AbortController, DOMException,
    blocks,
    t: (message) => message,
    readPlatformToken: async () => 'token',
    setPlatformConnected: () => {},
    currentTranslationLanguage: () => 'zh-CN',
    platformUrl: 'https://platform.test',
    splitTranslationBlocks: (items) => items,
    translationBatches,
    translationContext: () => '{}',
    combineTranslationParts: (source, parts) => [parts[0]],
    fetch: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        ok: true,
        json: async () => ({ translations: [] }),
      };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), sandbox);

  await vm.runInContext("requestPlatformTranslations({ url: 'https://a.test', title: 'T' }, blocks)", sandbox);

  assert.equal(peak, 6, 'platform translation saturates the engine semaphore without exceeding it');
});

test('a model list that resolves after the search filter keeps the filtered status', async () => {
  const elements = {
    'composer-model-search': { value: 'no-matching-model' },
    'composer-model-status': { textContent: '' },
    'composer-model-options': { innerHTML: '' },
  };
  let releaseModels;
  const modelsPending = new Promise(resolve => { releaseModels = resolve; });
  const rendered = [];
  const sandbox = {
    AbortController,
    readingMode: 'local',
    provider: { baseUrl: 'http://localhost:11434', model: 'local-test-chat', apiKey: '', providerKind: 'openai' },
    composerModelCache: null,
    composerModelController: null,
    $: id => elements[id] || null,
    show: () => {},
    t,
    providerReady: () => true,
    sameModelConnection: (a, b) => Boolean(a && b && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey && a.providerKind === b.providerKind),
    discoverModels: () => modelsPending,
    renderMaterialOptions: (host, options, selected) => { rendered.push({ options: options.map(item => item.id), selected }); },
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(panel, 'function closeComposerModelMenu(', 'async function chooseComposerModel('), sandbox);

  const pending = vm.runInContext("refreshComposerModels()", sandbox);
  assert.equal(elements['composer-model-status'].textContent, '正在读取模型列表…');
  releaseModels([{ id: 'local-test-chat-alt', label: 'local-test-chat-alt' }]);
  await pending;

  assert.equal(rendered.length, 1, 'the resolved model list is rendered once');
  assert.equal(rendered[0].options.length, 0, 'the current search term still filters every option out');
  assert.equal(elements['composer-model-status'].textContent, '没有匹配的模型。', 'the filtered status survives the model list refresh');
});
