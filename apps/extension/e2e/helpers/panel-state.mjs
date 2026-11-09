// State probes shared by the Reader control E2E.
//
// The control test installs a runtime.onMessage listener in the side panel that
// appends every received message to `window.__readerMessages`. These helpers
// turn that log and the rendered selection card into explicit wait conditions,
// so a slow or dropped event fails with a readable reason instead of waiting
// out Playwright's generic selector timeout.

// The content script debounces its page refresh for 400 ms after DOM changes.
// That refresh also clears its cached selection context. Waiting out the
// debounce (plus margin) is how the test lets a pending refresh land before it
// depends on the selection state.
export const PAGE_REFRESH_DEBOUNCE_MS = 400;
export const PAGE_REFRESH_SETTLE_MS = PAGE_REFRESH_DEBOUNCE_MS + 300;

export async function readerMessageMark(panel) {
  return panel.evaluate(() => (window.__readerMessages || []).length);
}

export async function readerMessagesSince(panel, from = 0) {
  return panel.evaluate((marker) => (window.__readerMessages || []).slice(marker), from);
}

// The panel only sets this blockquote when it has accepted a selection, so an
// exact quote is proof that the panel state moved on, not just that some old
// selection section is still on screen.
export async function waitForPanelSelection(panel, quote, { timeout = 10_000 } = {}) {
  await panel.waitForFunction(
    (expected) => (document.querySelector('#chat-selection-quote')?.textContent || '').trim() === expected,
    quote,
    { timeout },
  );
}

export async function waitForPanelMessage(panel, type, { from = 0, timeout = 10_000 } = {}) {
  await panel.waitForFunction(
    ({ marker, messageType }) => (window.__readerMessages || []).slice(marker).some((message) => message.type === messageType),
    { marker: from, messageType: type },
    { timeout },
  );
}

// Mirror the content script's mutation source in the page so the test can tell
// when a debounced refresh can no longer be pending. The content script
// observes the same document with childList/characterData only.
export async function installPageMutationRecorder(fixture) {
  await fixture.evaluate(() => {
    window.__readerMutations = { count: 0, last: Date.now() };
    const observer = new MutationObserver((records) => {
      window.__readerMutations.count += records.length;
      window.__readerMutations.last = Date.now();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  });
}

// A mutation can still have a page refresh queued for 400 ms after it happened.
// Waiting for mutation quiescence drains that timer; waiting for the *message*
// is not enough because the debounce starts before the context is sent.
export async function waitForPageMutationQuiet(fixture, { quietMs = PAGE_REFRESH_SETTLE_MS, timeout = 10_000 } = {}) {
  await fixture.waitForFunction(
    (quiet) => {
      const log = window.__readerMutations;
      return !log || Date.now() - log.last >= quiet;
    },
    quietMs,
    { timeout, polling: 100 },
  );
}

// Everything a placement failure needs: the panel's message log, the stored
// translation jobs, and the live page selection/DOM state in one snapshot.
export async function readerFailureSnapshot(panel, fixture) {
  const read = async (helper) => {
    try { return await helper(); } catch (error) { return `ERR:${error}`; }
  };
  return {
    panel: await read(() => panel.evaluate(async () => {
      const jobs = await new Promise((resolve) => {
        const request = indexedDB.open('deep-research-reader');
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('jobs')) { db.close(); resolve([]); return; }
          const all = db.transaction('jobs', 'readonly').objectStore('jobs').getAll();
          all.onsuccess = () => { resolve(all.result); db.close(); };
          all.onerror = () => { resolve([]); db.close(); };
        };
        request.onerror = () => resolve([]);
      });
      return {
        notice: document.querySelector('#notice')?.textContent || '',
        summary: document.querySelector('#translation-summary-text')?.textContent || '',
        selectionQuote: (document.querySelector('#chat-selection-quote')?.textContent || '').trim(),
        selectionSectionVisible: Boolean(document.querySelector('#selection-section')?.offsetParent),
        jobState: jobs.map((job) => ({
          id: job.id,
          status: job.status,
          kind: job.kind,
          textDone: job.textDone,
          textTotal: job.textTotal,
          failed: (job.failedItems || []).map((item) => ({ id: item.id, error: item.error })),
        })),
        messages: (window.__readerMessages || []).slice(-300),
      };
    })),
    page: await read(() => fixture.evaluate(() => {
      const popup = document.querySelector('[data-deep-research-selection-translation]');
      return {
        selection: window.getSelection()?.toString() || '',
        toolbar: Boolean(document.querySelector('[data-deep-research-toolbar]')),
        popupCount: document.querySelectorAll('[data-deep-research-selection-translation]').length,
        popupText: popup?.shadowRoot?.querySelector('.text')?.textContent || '',
        translatedBlocks: document.querySelectorAll('[data-deep-research-translation]').length,
        translationIds: Array.from(document.querySelectorAll('[data-deep-research-translation]')).map((node) => node.getAttribute('data-deep-research-translation-for') || 'selection'),
        targetDisplay: document.querySelector('#target') ? getComputedStyle(document.querySelector('#target')).display : '',
        targetText: document.querySelector('#target')?.textContent || '',
      };
    })),
  };
}
