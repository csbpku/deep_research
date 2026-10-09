import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const panel = readFileSync(new URL('./sidepanel.js', import.meta.url), 'utf8');
const content = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
function extract(source, start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

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
    DOMException, context, translationController: controller, activeJobRecord: job,
    translationRequested: true, translationRunning: true, activeTranslationRun: 1,
    failedTranslationItems: [], translatedTextIds: new Set(), translatedImageIds: new Set(),
    platformModeReady: () => true, boundTaskContext: (c) => c, currentReadingLanguage: () => 'zh-CN',
    updatePageContextUi: () => {}, updateReaderTranslations: () => {}, translationCoverageWarning: () => '', makeDocument: (c) => c,
    persistJobPatch: (j, p) => Object.assign(j, p), renderProgress: () => {}, sendToPage: () => {},
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
      TextDecoder, scope: 'page', sourceContext: { url: 'https://a.test' }, discussionHistory: [], platformUrl: 'https://platform.test',
      platformContext: (c) => c,
      chrome: { storage: { local: { get: async () => ({ readerToken: 'test' }) } } },
      fetch: async () => ({ ok: true, body: { getReader: () => ({ read: async () => {
        if (emitted) return { done: true };
        emitted = true;
        return { done: false, value: new TextEncoder().encode(frame) };
      } }) } }),
    };
    vm.createContext(sandbox);
    vm.runInContext(extract(panel, 'async function requestPlatformAnswer(', 'function platformAnswerErrorMessage('), sandbox);
    await assert.rejects(vm.runInContext("requestPlatformAnswer(sourceContext, 'question', scope)", sandbox), /未保存为完整结论/);
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
  const handler = extract(content, "  document.addEventListener('keydown',", '  function showSelectionToolbar(');
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
      chrome: { storage: { local: { get: async () => ({ readerToken: 'test' }) } } },
      platformUrl: 'https://platform.test', insightSyncFailed: false,
      updateReadingModeUi: () => {}, setNotice: (n) => notices.push(n),
      fetch: async (_url, request) => {
        methods.push(request.method);
        return request.method === 'POST'
          ? { ok: true, json: async () => ({ deduplicated: true }) }
          : { ok: updateOk, json: async () => updateOk ? { updated: true } : {} };
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(extract(panel, 'async function syncInsight(', 'async function syncCurrentSession('), sandbox);
    await vm.runInContext("syncInsight({ id: 'saved-id', url: 'https://source.test', title: 'Source', quote: 'Quote', note: 'Edited' })", sandbox);
    assert.deepEqual(methods, ['POST', 'PUT']);
    assert.equal(sandbox.insightSyncFailed, !updateOk);
    assert.match(notices.at(-1), updateOk ? /已更新/ : /云端尚未更新/);
  }
});


test('platform translation resumes completed batches without requesting them again', async () => {
  const context = { url: 'https://a.test', blocks: [{ id: 'a', text: 'First' }, { id: 'b', text: 'Second' }], images: [] };
  const { sandbox, job } = translationSandbox(context, () => {});
  const batches = [];
  sandbox.requestPlatformTranslations = async (_context, blocks, options) => {
    batches.push(blocks.map((b) => b.id));
    const translated = { ...blocks[0], sourceText: blocks[0].text, text: '译文' };
    options.onResult(translated);
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


test('workspace navigation selects one view and composer resize is bounded and keyboard accessible', () => {
  const shell = { dataset: {}, classList: { toggle() {} } };
  const nodes = new Map();
  for (const id of ['nav-chat', 'nav-tools', 'nav-library', 'open-wide-window', 'composer-resize', 'question-input']) {
    nodes.set(id, { handlers: {}, attributes: {}, style: {}, classList: { toggle: () => {}, add: () => {} },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; },
      getBoundingClientRect() { return { height: Number.parseInt(this.style.height || '80', 10) }; },
    });
  }
  const sandbox = {
    document: { querySelector: () => shell }, $: (id) => nodes.get(id),
    window: { innerHeight: 900 }, localStorage: { getItem: () => null, setItem: () => {} },
    boundWindowTabId: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(panel, 'function setWorkspaceView(', 'function show('), sandbox);
  vm.runInContext("setWorkspaceView('library'); setupWorkspaceLayout();", sandbox);
  assert.equal(shell.dataset.workspaceView, 'library');
  assert.equal(nodes.get('nav-library').attributes['aria-pressed'], 'true');
  assert.equal(nodes.get('nav-chat').attributes['aria-pressed'], 'false');
  const handle = nodes.get('composer-resize');
  const key = (value) => handle.handlers.keydown({ key: value, preventDefault() {} });
  key('End');
  assert.equal(nodes.get('question-input').style.height, '240px');
  key('Home');
  key('ArrowUp');
  assert.equal(nodes.get('question-input').style.height, '76px');
  assert.equal(handle.attributes['aria-valuenow'], '76');
});

test('source messages target the bound article instead of the extension tab', async () => {
  const background = readFileSync(new URL('./background.js', import.meta.url), 'utf8');
  const handler = extract(background, "  if (message?.type === 'deep-research:to-page')", '\n});');
  const sent = [];
  const sandbox = {
    message: { type: 'deep-research:to-page', tabId: 42, payload: { type: 'deep-research:request-page' } },
    sender: { url: 'chrome-extension://test/sidepanel.html?sourceTab=42' },
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
