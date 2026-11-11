const cancelled = () => new DOMException('模型请求已取消', 'AbortError');

// Shared by translation and answer workers in the same MV3 runtime. Leave a
// slot for interaction instead of letting a whole-page translation occupy all
// capacity. Endpoint-wide cooldown also covers different models on one key.
export function createModelScheduler({ maxConcurrent = 4, maxBackground = 3, now = Date.now } = {}) {
  const endpoints = new Map();
  function stateFor(key) {
    if (!endpoints.has(key)) endpoints.set(key, { active: 0, background: 0, queue: [], until: 0, timer: null });
    return endpoints.get(key);
  }
  function pump(state) {
    clearTimeout(state.timer);
    state.timer = null;
    if (!state.queue.length) return;
    const delay = state.until - now();
    if (delay > 0) {
      state.timer = setTimeout(() => pump(state), Math.min(delay, 60_000));
      return;
    }
    while (state.active < maxConcurrent) {
      const interactive = state.queue.findIndex(item => !item.background);
      // If no interaction is queued, keep one slot free for the next one.
      const index = interactive >= 0 ? interactive : state.background < maxBackground ? 0 : -1;
      if (index < 0 || !state.queue.length) break;
      const [item] = state.queue.splice(index, 1);
      item.signal?.removeEventListener('abort', item.abort);
      state.active += 1;
      if (item.background) state.background += 1;
      Promise.resolve().then(() => {
        if (item.signal?.aborted) throw cancelled();
        return item.work();
      }).then(item.resolve, item.reject).finally(() => {
        state.active -= 1;
        if (item.background) state.background -= 1;
        pump(state);
      });
    }
  }
  return {
    cooldown(key, delayMs) {
      const state = stateFor(key);
      state.until = Math.max(state.until, now() + delayMs);
      pump(state);
    },
    run(key, work, { priority, signal } = {}) {
      if (signal?.aborted) return Promise.reject(cancelled());
      const state = stateFor(key);
      return new Promise((resolve, reject) => {
        const item = { work, resolve, reject, signal, background: priority === 'background' };
        item.abort = () => {
          const index = state.queue.indexOf(item);
          if (index >= 0) state.queue.splice(index, 1);
          signal.removeEventListener('abort', item.abort);
          reject(cancelled());
          pump(state);
        };
        signal?.addEventListener('abort', item.abort, { once: true });
        state.queue.push(item);
        pump(state);
      });
    },
  };
}

export function retryDelay(headers, attempt, now = Date.now()) {
  const value = headers.get('retry-after');
  const seconds = value?.trim() ? Number(value) : NaN;
  const fromHeader = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
    : value ? Math.max(0, Date.parse(value) - now) : NaN;
  // Retry-After is a minimum, including HTTP-date values. A missing header
  // uses exponential backoff with jitter to avoid synchronized retries.
  return Number.isFinite(fromHeader) ? fromHeader : 1000 * 2 ** attempt + Math.floor(Math.random() * 250);
}

export const modelScheduler = createModelScheduler();
