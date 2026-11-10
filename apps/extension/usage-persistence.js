import { USAGE_KEY, pruneUsage, recordUsage, usageDay } from './usage-meter.js';

/**
 * Create once in the background worker and route every panel's usage events
 * through it. Each event reads after the preceding write commits, so separate
 * callers cannot overwrite another request's counters with a stale snapshot.
 *
 * Storage uses chrome.storage.local's async get/set interface. Errors reject
 * the affected call; the queue recovers so later events can still be recorded.
 * Only counter fields are copied from the event and persisted by recordUsage.
 */
export function createUsageRecorder(storage, options = {}) {
  const keepDays = options.keepDays ?? 120;
  const now = options.now || (() => new Date());
  let queue = Promise.resolve();

  return (event = {}) => {
    const input = event && typeof event === 'object' ? event : {};
    const counters = {
      kind: input.kind,
      requests: input.requests,
      chars: input.chars,
      tokens: input.tokens,
      day: input.day ?? usageDay(now()),
    };
    const result = queue.then(async () => {
      const stored = await storage.get(USAGE_KEY);
      const usage = pruneUsage(recordUsage(stored?.[USAGE_KEY], counters), { keepDays, today: now() });
      await storage.set({ [USAGE_KEY]: usage });
      return usage;
    });
    queue = result.catch(() => {});
    return result;
  };
}
