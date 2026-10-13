import { readerStore } from './reader-store.js';
import { loadProvider, explainSelection, explainImage } from './reader-core.js';
import { requestPlatformAnswer } from './platform-answer.js';

const tasks = new Map();
const key = id => `readerAnswer:${id}`;
const emit = task => chrome.runtime.sendMessage({ type: 'deep-research:answer-update', task }).catch(() => {});
const snapshot = async id => {
  const value = (await chrome.storage.session.get(key(id)))[key(id)];
  if (value?.status === 'running' && !tasks.has(id)) return { ...value, status: 'interrupted', error: '浏览器停止了后台任务；已保留问题，请重试。' };
  return value;
};

async function execute(input, task, controller) {
  // Extension API traffic keeps MV3 alive while a model is silent. This cannot
  // survive browser shutdown; interrupted tasks are reported, never replayed.
  const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
  let lastSaved = 0;
  const publish = (force = false) => {
    if (force || Date.now() - lastSaved > 200) {
      lastSaved = Date.now();
      void chrome.storage.session.set({ [key(task.id)]: { ...task } });
      void emit({ ...task });
    }
  };
  try {
    const options = {
      signal: controller.signal, maxTokens: input.maxTokens,
      history: input.history, action: input.action, platformUrl: input.platformUrl, language: input.language,
      onDelta: delta => { task.streamed += delta; publish(); },
      onProgress: (...progress) => { task.progress = progress; publish(true); },
    };
    const provider = input.mode === 'standalone' ? await loadProvider() : null;
    const result = input.mode === 'platform'
      ? await requestPlatformAnswer(input.context, input.question, input.scope, options)
      : input.scope === 'image'
        ? await explainImage(provider, input.context, input.image, input.question, input.history, options)
        : await explainSelection(provider, { ...input.context, scope: input.scope }, input.question, input.history, options);
    if (controller.signal.aborted) throw new DOMException('回答已停止', 'AbortError');
    const session = await readerStore.getSession(input.context.url, input.context.contentHash || null);
    const discussion = [...input.history, { role: 'user', content: input.userMessage }, { role: 'assistant', content: result.answer || '' }].slice(-20);
    await readerStore.saveSession({ ...session, url: input.context.url, title: session?.title || input.context.title, version: input.context.contentHash || null, selection: input.context.selection || null, discussion, discussionScope: input.scope, discussionIntent: input.intent, answer: result.answer || '', answerStructured: result });
    task.result = result; task.status = 'completed';
  } catch (error) {
    task.status = controller.signal.aborted ? 'cancelled' : 'failed';
    task.error = error.message || '回答未完成';
  } finally {
    clearInterval(keepAlive); tasks.delete(task.id);
    await chrome.storage.session.set({ [key(task.id)]: { ...task } });
    await emit({ ...task });
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only extension documents can start model requests; web content supplies context.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || !message?.type?.startsWith('deep-research:answer-')) return false;
  if (message.type === 'deep-research:answer-start') {
    const input = message.input;
    if (!input?.id || !input.context?.url || !Array.isArray(input.history)) { sendResponse({ ok: false, error: '回答缺少原文上下文' }); return false; }
    const active = [...tasks.values()].find(value => value.task.url === input.context.url);
    if (active) { sendResponse({ ok: false, error: '当前文章已有回答进行中，请等待或停止' }); return false; }
    const controller = new AbortController();
    const task = { id: input.id, url: input.context.url, contentHash: input.context.contentHash, scope: input.scope, question: input.userMessage, prompt: input.question, status: 'running', streamed: '', startedAt: Date.now() };
    tasks.set(input.id, { controller, task });
    chrome.storage.session.set({ [key(input.id)]: task }).then(() => { sendResponse({ ok: true }); void execute(input, task, controller); }).catch(error => { tasks.delete(input.id); sendResponse({ ok: false, error: error.message }); });
    return true;
  }
  if (message.type === 'deep-research:answer-cancel') { tasks.get(message.id)?.controller.abort(); sendResponse({ ok: true }); return false; }
  if (message.type === 'deep-research:answer-state') { void snapshot(message.id).then(sendResponse); return true; }
  if (message.type === 'deep-research:answer-current') {
    void chrome.storage.session.get(null).then(stored => {
      const task = Object.entries(stored).filter(([name, value]) => name.startsWith('readerAnswer:') && value.url === message.url && (!message.contentHash || value.contentHash === message.contentHash)).map(([, value]) => value).sort((a, b) => b.startedAt - a.startedAt)[0];
      return task ? snapshot(task.id) : null;
    }).then(sendResponse);
    return true;
  }
  return false;
});
