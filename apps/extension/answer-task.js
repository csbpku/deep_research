// The panel subscribes to a worker task; closing this document never cancels it.
export function waitForAnswerTask(id, options = {}) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { chrome.runtime.onMessage.removeListener(listener); options.signal?.removeEventListener('abort', abort); };
    const consume = snapshot => {
      if (!snapshot || snapshot.id !== id) return;
      if (snapshot.streamed) options.onDelta?.(snapshot.streamed);
      if (snapshot.progress) options.onProgress?.(...snapshot.progress);
      if (snapshot.status === 'completed') { cleanup(); resolve(snapshot.result); }
      else if (['failed', 'cancelled', 'interrupted'].includes(snapshot.status)) { cleanup(); reject(snapshot.status === 'cancelled' ? new DOMException('回答已停止', 'AbortError') : new Error(snapshot.error || '回答未完成，请重试')); }
    };
    const listener = message => { if (message.type === 'deep-research:answer-update') consume(message.task); };
    const abort = () => { void chrome.runtime.sendMessage({ type: 'deep-research:answer-cancel', id }).catch(() => {}); cleanup(); reject(new DOMException('回答已停止', 'AbortError')); };
    chrome.runtime.onMessage.addListener(listener);
    options.signal?.addEventListener('abort', abort, { once: true });
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
