/** Only our packaged article can use its self-loaded content script. */
export function isBundledDemoUrl(value, demoUrl) {
  if (typeof value !== 'string' || typeof demoUrl !== 'string') return false;
  try {
    const candidate = new URL(value);
    const bundled = new URL(demoUrl);
    // URL.origin is "null" for extension schemes in several runtimes, so it
    // cannot distinguish this extension from another extension's document.
    return bundled.protocol === 'chrome-extension:'
      && Boolean(bundled.hostname)
      && bundled.pathname === '/demo.html'
      && !bundled.username && !bundled.password && !bundled.port
      && candidate.protocol === bundled.protocol
      && candidate.host === bundled.host
      && !candidate.username && !candidate.password && !candidate.port
      && candidate.pathname === bundled.pathname;
  } catch {
    return false;
  }
}

/**
 * Wait for demo.html's own listener instead of injecting into an extension
 * document. A fulfilled delivery is sufficient: request-page currently sends
 * its context asynchronously and intentionally has no response payload.
 *
 * The overall deadline also bounds a message channel that never settles. The
 * transport cannot be cancelled, but a late settlement never starts retries.
 */
export async function requestDemoContext(tabId, { sendMessage, attempts = 20, delayMs = 250 } = {}) {
  const count = Number(attempts);
  const delay = Number(delayMs);
  if (!Number.isInteger(tabId) || tabId < 0 || typeof sendMessage !== 'function'
      || !Number.isFinite(count) || count < 1 || !Number.isFinite(delay) || delay < 0) return false;
  const limit = Math.min(20, Math.floor(count));
  const retryDelay = Math.min(1000, delay);
  let finished = false;
  let deadlineTimer;
  let retryTimer;
  let finishDelay;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => {
      finished = true;
      resolve(false);
    }, limit * Math.max(1, retryDelay));
  });
  const run = async () => {
    for (let attempt = 0; attempt < limit && !finished; attempt += 1) {
      try {
        await sendMessage(tabId, { type: 'deep-research:request-page' });
        return !finished;
      } catch {
        if (finished) return false;
      }
      if (attempt + 1 < limit && retryDelay > 0) {
        await new Promise((resolve) => {
          finishDelay = resolve;
          retryTimer = setTimeout(resolve, retryDelay);
        });
      }
    }
    return false;
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    finished = true;
    clearTimeout(deadlineTimer);
    clearTimeout(retryTimer);
    finishDelay?.();
  }
}
