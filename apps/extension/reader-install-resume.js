import { getTrustedReaderPlatformOrigin, validateRadarSourceUrl } from './reader-platform-bridge-utils.js';

const PENDING_KEY = 'dr:reader-pending-install';
const MAX_AGE_MS = 10 * 60 * 1000;

// These functions execute in the platform page's isolated extension world.
function readPending(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; }
}
function claimPending(key, id) {
  try {
    const pending = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!pending || pending.id !== id || pending.status !== 'pending') return false;
    sessionStorage.setItem(key, JSON.stringify({ ...pending, status: 'opening' }));
    return true;
  } catch { return false; }
}
function finishPending(key, id, success) {
  try {
    const pending = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (!pending || pending.id !== id || pending.status !== 'opening') return;
    if (success) {
      sessionStorage.removeItem(key);
      window.postMessage({ type: 'deep-research:install-resumed' }, location.origin);
    } else sessionStorage.setItem(key, JSON.stringify({ ...pending, status: 'pending' }));
  } catch { /* the user can continue manually */ }
}

export async function resumePendingInstall(api, now = Date.now()) {
  const tabs = await api.tabs.query({ url: ['https://techradar.top/*', 'https://www.techradar.top/*'] });
  const candidates = [];
  for (const tab of tabs) {
    const origin = getTrustedReaderPlatformOrigin({ url: tab.url });
    if (!origin || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) continue;
    try {
      const [result] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: readPending, args: [PENDING_KEY] });
      const pending = result?.result;
      const age = now - pending?.createdAt;
      const url = validateRadarSourceUrl(pending?.url, origin);
      if (url && typeof pending.id === 'string' && pending.status === 'pending'
        && Number.isFinite(age) && age >= 0 && age <= MAX_AGE_MS) candidates.push({ tab, pending, url });
    } catch { /* closed, restricted, or unavailable page */ }
  }
  candidates.sort((a, b) => b.pending.createdAt - a.pending.createdAt);
  const chosen = candidates[0];
  if (!chosen) return false;
  const target = { tabId: chosen.tab.id };
  try {
    // Installation does not automatically inject content scripts into an
    // existing tab. This also enables the manual continuation button.
    await api.scripting.executeScript({ target, files: ['reader-platform-bridge.js'] });
    const [claimed] = await api.scripting.executeScript({ target, func: claimPending, args: [PENDING_KEY, chosen.pending.id] });
    if (!claimed?.result) return false;
    try {
      await api.tabs.create({ url: chosen.url, windowId: chosen.tab.windowId, active: true });
    } catch (error) {
      await api.scripting.executeScript({ target, func: finishPending, args: [PENDING_KEY, chosen.pending.id, false] });
      throw error;
    }
    await api.scripting.executeScript({ target, func: finishPending, args: [PENDING_KEY, chosen.pending.id, true] });
    return true;
  } catch { return false; }
}
