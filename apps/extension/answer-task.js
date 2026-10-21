// A model instruction is never a composer draft or a visible chat message.
// Legacy snapshots kept both `prompt` (internal) and `question` (display).
export function answerTaskPresentation(task = {}) {
  const userMessage = String(task.userMessage || task.question || '').trim();
  const draft = typeof task.draft === 'string' ? task.draft
    : task.intent === 'ask' ? userMessage
      : !task.intent && task.question && task.prompt === task.question ? task.question : '';
  return { userMessage, draft };
}

// The panel subscribes to a worker task; closing this document never cancels it.
export function waitForAnswerTask(id, options = {}) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { chrome.runtime.onMessage.removeListener(listener); options.signal?.removeEventListener('abort', abort); options.detachSignal?.removeEventListener('abort', detach); };
    const consume = snapshot => {
      if (!snapshot || snapshot.id !== id) return;
      if (snapshot.streamed) options.onDelta?.(snapshot.streamed);
      if (snapshot.progress) options.onProgress?.(...snapshot.progress);
      if (snapshot.status === 'completed') { cleanup(); resolve(snapshot.result); }
      else if (['failed', 'cancelled', 'interrupted'].includes(snapshot.status)) { cleanup(); reject(snapshot.status === 'cancelled' ? new DOMException('回答已停止', 'AbortError') : new Error(snapshot.error || '回答未完成，请重试')); }
    };
    const listener = message => { if (message.type === 'deep-research:answer-update') consume(message.task); };
    const abort = () => { void chrome.runtime.sendMessage({ type: 'deep-research:answer-cancel', id }).catch(() => {}); cleanup(); reject(new DOMException('回答已停止', 'AbortError')); };
    // Navigating to another article stops observing this task, not the task
    // itself. Returning to the article subscribes again to the worker snapshot.
    const detach = () => { cleanup(); reject(new DOMException('已切换文章', 'AbortError')); };
    chrome.runtime.onMessage.addListener(listener);
    options.signal?.addEventListener('abort', abort, { once: true });
    options.detachSignal?.addEventListener('abort', detach, { once: true });
    if (options.detachSignal?.aborted) { detach(); return; }
    if (options.signal?.aborted) { abort(); return; }
    // Closes the subscribe/snapshot race if the task completes before subscription.
    void chrome.runtime.sendMessage({ type: 'deep-research:answer-state', id }).then(consume).catch(error => { cleanup(); reject(error); });
  });
}
export async function requestAnswerTask(input, options) {
  const response = await chrome.runtime.sendMessage({ type: 'deep-research:answer-start', input });
  if (!response?.ok) throw new Error(response?.error || '无法启动回答');
  return waitForAnswerTask(input.id, options);
}
