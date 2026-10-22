const DB_NAME = 'deep-research-reader';
const DB_VERSION = 4;
const STORE_NAMES = ['sessions', 'insights', 'annotations', 'settings', 'cache', 'jobs', 'taskInputs'];
const MAX_TRANSLATION_CACHE_ENTRIES = 500;
const memoryStores = new Map(STORE_NAMES.map((name) => [name, new Map()]));

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('本地存储失败'));
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      STORE_NAMES.forEach((name) => {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: 'id' });
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开本地阅读库'));
  });
}

function fallbackKey(store, id) {
  return `deep-research-reader:${store}:${id}`;
}

function fallbackSet(store, value) {
  if (globalThis.localStorage) {
    localStorage.setItem(fallbackKey(store, value.id), JSON.stringify(value));
    return value;
  }
  memoryStores.get(store)?.set(value.id, value);
  return value;
}

function fallbackGet(store, id) {
  if (globalThis.localStorage) return JSON.parse(localStorage.getItem(fallbackKey(store, id)) || 'null');
  return memoryStores.get(store)?.get(id) || null;
}

function fallbackAll(store) {
  if (globalThis.localStorage) {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(`deep-research-reader:${store}:`))
      .map((key) => JSON.parse(localStorage.getItem(key)))
      .filter(Boolean);
  }
  return Array.from(memoryStores.get(store)?.values() || []);
}

function fallbackRemove(store, id) {
  if (globalThis.localStorage) localStorage.removeItem(fallbackKey(store, id));
  memoryStores.get(store)?.delete(id);
}

async function withStore(store, mode, operation) {
  const database = await openDatabase().catch(() => null);
  if (!database) return operation(null);
  const transaction = database.transaction(store, mode);
  const objectStore = transaction.objectStore(store);
  const result = await operation(objectStore);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('本地阅读库事务失败'));
    transaction.onabort = () => reject(transaction.error || new Error('本地阅读库事务中断'));
  });
  database.close();
  return result;
}

async function put(store, value) {
  try {
    return await withStore(store, 'readwrite', async (objectStore) => {
      if (!objectStore) {
        return fallbackSet(store, value);
      }
      await requestToPromise(objectStore.put(value));
      return value;
    });
  } catch {
    return fallbackSet(store, value);
  }
}

async function get(store, id) {
  try {
    return await withStore(store, 'readonly', async (objectStore) => {
      if (!objectStore) return fallbackGet(store, id);
      return requestToPromise(objectStore.get(id));
    });
  } catch {
    return fallbackGet(store, id);
  }
}

async function all(store) {
  try {
    return await withStore(store, 'readonly', async (objectStore) => {
      if (!objectStore) {
        return fallbackAll(store);
      }
      return requestToPromise(objectStore.getAll());
    });
  } catch {
    return fallbackAll(store);
  }
}

async function remove(store, id) {
  try {
    return await withStore(store, 'readwrite', async (objectStore) => {
      if (!objectStore) {
        fallbackRemove(store, id);
        return;
      }
      if (globalThis.localStorage) localStorage.removeItem(fallbackKey(store, id));
      await requestToPromise(objectStore.delete(id));
    });
  } catch {
    fallbackRemove(store, id);
  }
}

function pageKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.searchParams.delete('deep-research-anchor');
    return parsed.toString();
  } catch {
    return url;
  }
}

function sessionKey(url, version = null) {
  const normalized = pageKey(url);
  return `${normalized}::${version || 'latest'}`;
}

// Knowledge matching is broader than session/anchor identity. Do not migrate
// session keys or reuse this key to decide whether an old anchor can be drawn.
function knowledgePageKey(value) {
  if (!validPageUrl(value)) return '';
  const url = new URL(value);
  if (url.username || url.password) return '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/iu.test(key) || /^(fbclid|gclid|deep-research-(anchor|source|summary|platform))$/iu.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.toString();
}

function normalizeRadarSummaryId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.trim())
    ? value.trim().toLowerCase() : '';
}

function platformOrigin(value) {
  if (!validPageUrl(value)) return '';
  const url = new URL(value);
  return url.username || url.password ? '' : url.origin;
}

function captureInsightSource(source, context = {}) {
  const url = source?.url || source?.document?.url;
  // An explicit (even empty) source wins over the currently open radar.
  const radarSummaryId = Object.hasOwn(source || {}, 'radarSummaryId')
    ? normalizeRadarSummaryId(source.radarSummaryId)
    : knowledgePageKey(url) && knowledgePageKey(url) === knowledgePageKey(context.url)
      ? normalizeRadarSummaryId(context.radarSummaryId) : '';
  return { ...source, radarSummaryId: radarSummaryId || undefined };
}

function createUuidV4() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // This is only a last-resort browser fallback. It still satisfies the
  // UUID-v4 wire contract used by the optional platform sync endpoint.
  const randomNibble = () => Math.floor(Math.random() * 16).toString(16);
  const segment = (length) => Array.from({ length }, randomNibble).join('');
  return `${segment(8)}-${segment(4)}-4${segment(3)}-${['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]}${segment(3)}-${segment(12)}`;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validPageUrl(value) {
  if (typeof value !== 'string' || value.length > 4_000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function withoutSecret(value) {
  if (Array.isArray(value)) return value.map((item) => withoutSecret(item));
  if (!isRecord(value)) return value;
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    // Exported local data can contain user-edited or imported records. Strip
    // credentials recursively so an unexpected field nested in a saved
    // insight, session, or model response can never become an export leak.
    if (['apiKey', 'API_KEY', 'key', 'readerToken', 'token', 'authorization'].includes(key)) continue;
    safe[key] = withoutSecret(item);
  }
  return safe;
}

function normalizeAnnotation(value, fallbackId = createUuidV4()) {
  if (!isRecord(value) || !isRecord(value.document) || !isRecord(value.anchor)) return null;
  if (!validPageUrl(value.document.url) || typeof value.anchor.quote !== 'string' || !value.anchor.quote.trim()) return null;
  const anchor = {
    quote: value.anchor.quote.slice(0, 12_000),
    prefix: typeof value.anchor.prefix === 'string' ? value.anchor.prefix.slice(0, 500) : '',
    suffix: typeof value.anchor.suffix === 'string' ? value.anchor.suffix.slice(0, 500) : '',
  };
  for (const key of ['startOffset', 'endOffset']) {
    if (Number.isFinite(value.anchor[key])) anchor[key] = Math.max(0, Math.floor(value.anchor[key]));
  }
  for (const key of ['contentHash', 'selectorPath']) {
    if (typeof value.anchor[key] === 'string' && value.anchor[key].length <= 1_000) anchor[key] = value.anchor[key];
  }
  return {
    id: typeof value.id === 'string' && value.id.length <= 200 ? value.id : fallbackId,
    document: {
      url: value.document.url,
      title: typeof value.document.title === 'string' ? value.document.title.slice(0, 500) : value.document.url,
      version: typeof value.document.version === 'string' ? value.document.version.slice(0, 256) : null,
    },
    anchor,
    note: typeof value.note === 'string' ? value.note.slice(0, 8_000) : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  };
}

export const readerStore = {
  pageKey,
  knowledgePageKey,
  normalizeRadarSummaryId,
  captureInsightSource,
  async getClientId() {
    const existing = await get('settings', 'clientId');
    if (typeof existing?.value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(existing.value)) {
      return existing.value;
    }
    const clientId = createUuidV4();
    await put('settings', { id: 'clientId', value: clientId, updatedAt: new Date().toISOString() });
    return clientId;
  },
  async getSetting(id, fallback = null) {
    return (await get('settings', id))?.value ?? fallback;
  },
  async setSetting(id, value) {
    return put('settings', { id, value, updatedAt: new Date().toISOString() });
  },
  async getSession(url, version = null) {
    if (version) return get('sessions', sessionKey(url, version));
    const normalized = pageKey(url);
    const matches = (await all('sessions')).filter((session) => pageKey(session.url) === normalized);
    return matches.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt) || '') || String(b.id).localeCompare(String(a.id)))[0] || null;
  },
  async getReadingSession(url, version = null) {
    const matches = (await all('sessions'))
      .filter(session => pageKey(session.url) === pageKey(url))
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    if (!matches.length) return null;
    const conversational = matches.filter(session => session.discussion?.length || session.answer);
    const latest = conversational.at(-1) || matches.find(session => session.version === version) || matches.at(-1);
    let discussion = [];
    const equal = (a, b) => a?.id && b?.id ? a.id === b.id : a?.role === b?.role && a?.content === b?.content;
    for (const session of conversational) {
      const incoming = session.discussion || [];
      // Sessions from older releases are snapshots. Find their shared prefix
      // or overlap before appending so refreshing a page does not duplicate turns.
      let prefix = 0;
      while (prefix < discussion.length && prefix < incoming.length && equal(discussion[prefix], incoming[prefix])) prefix += 1;
      if (prefix === incoming.length) continue;
      if (prefix) { discussion.push(...incoming.slice(prefix)); continue; }
      let overlap = Math.min(discussion.length, incoming.length);
      while (overlap && !incoming.slice(0, overlap).every((item, index) => equal(discussion[discussion.length - overlap + index], item))) overlap -= 1;
      discussion.push(...incoming.slice(overlap));
    }
    return { ...latest, discussion, stale: Boolean(version && latest.version && version !== latest.version) };
  },
  async saveSession(session) {
    const id = session.id || sessionKey(session.url, session.version);
    const existing = await get('sessions', id);
    const incomingDiscussion = Array.isArray(session.discussion) ? session.discussion : [];
    const existingDiscussion = Array.isArray(existing?.discussion) ? existing.discussion : [];
    const preserveExistingConversation = Boolean(
      existing
      && existingDiscussion.length > incomingDiscussion.length
      && (existing.answer || existing.answerStructured),
    );
    return put('sessions', {
      ...(preserveExistingConversation ? existing : {}),
      ...session,
      id,
      selection: session.selection || (preserveExistingConversation ? existing.selection : null),
      answer: preserveExistingConversation ? existing.answer : session.answer,
      answerStructured: preserveExistingConversation ? existing.answerStructured : session.answerStructured,
      discussion: preserveExistingConversation ? existingDiscussion : incomingDiscussion,
      discussionScope: preserveExistingConversation ? existing.discussionScope : session.discussionScope,
      discussionIntent: preserveExistingConversation ? existing.discussionIntent : session.discussionIntent,
      updatedAt: new Date().toISOString(),
    });
  },
  async listSessions() {
    return (await all('sessions')).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  },
  async markSessionsStale(url, currentVersion) {
    if (!url || !currentVersion) return;
    const normalized = pageKey(url);
    const sessions = await all('sessions');
    await Promise.all(sessions
      .filter((session) => pageKey(session.url) === normalized && session.version && session.version !== currentVersion && !session.stale)
      .map((session) => put('sessions', {
        ...session,
        stale: true,
        staleAgainstVersion: currentVersion,
        updatedAt: session.updatedAt || new Date().toISOString(),
      })));
  },
  async deleteSession(url, version = null) {
    const matches = (await all('sessions')).filter((session) => (
      pageKey(session.url) === pageKey(url)
      && (version === null || version === undefined || session.version === version)
    ));
    await Promise.all(matches.map((session) => remove('sessions', session.id)));
  },
  async getSessionSyncKey(url, version = null) {
    const identity = `session-sync:${pageKey(url)}::${version || 'latest'}`;
    let digest = '';
    if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
      const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
      digest = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    const settingId = `sessionSync:${digest || identity.slice(0, 96)}`;
    const existing = await get('settings', settingId);
    if (typeof existing?.value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(existing.value)) {
      return existing.value;
    }
    let syncKey = createUuidV4();
    if (digest.length >= 32) {
      const hex = digest.slice(0, 32).split('');
      hex[12] = '4';
      hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
      syncKey = `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`;
    }
    await put('settings', { id: settingId, value: syncKey, updatedAt: new Date().toISOString() });
    return syncKey;
  },
  async saveInsight(insight) {
    return put('insights', {
      ...insight,
      radarSummaryId: normalizeRadarSummaryId(insight.radarSummaryId) || undefined,
      tags: Array.isArray(insight.tags) ? insight.tags.slice(0, 10) : [],
      id: insight.id || createUuidV4(),
      createdAt: insight.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },
  async linkInsightToPlatform(id, researchId, origin) {
    const normalizedId = normalizeRadarSummaryId(researchId);
    const normalizedOrigin = platformOrigin(origin);
    if (!normalizedId || !normalizedOrigin) return null;
    // Read and patch in one transaction so an in-flight response cannot undo
    // a concurrent edit or resurrect a deleted insight.
    return withStore('insights', 'readwrite', async objectStore => {
      const insight = objectStore ? await requestToPromise(objectStore.get(id)) : fallbackGet('insights', id);
      if (!insight) return null;
      const linked = { ...insight, platformResearchId: normalizedId, platformOrigin: normalizedOrigin };
      if (objectStore) await requestToPromise(objectStore.put(linked));
      else fallbackSet('insights', linked);
      return linked;
    });
  },
  async listPageKnowledge(url, { version = null, platformItems = [], origin = '', limit = 3 } = {}) {
    const key = knowledgePageKey(url);
    if (!key) return [];
    const [insights, annotations] = await Promise.all([all('insights'), all('annotations')]);
    const connectedOrigin = platformOrigin(origin);
    const local = [
      ...insights.map(item => ({ ...item, kind: 'insight' })),
      ...annotations.map(item => ({ ...item, kind: 'annotation', url: item.document?.url })),
    ].filter(item => knowledgePageKey(item.url || item.document?.url) === key)
      .map(item => ({
        ...item,
        stale: Boolean(version && item.document?.version && version !== item.document.version),
        platformResearchId: connectedOrigin && platformOrigin(item.platformOrigin) === connectedOrigin
          ? normalizeRadarSummaryId(item.platformResearchId) || undefined : undefined,
      }));
    const linked = new Set(local.map(item => item.platformResearchId).filter(Boolean));
    const remote = connectedOrigin && Array.isArray(platformItems) ? platformItems
      .filter(item => item && normalizeRadarSummaryId(item.id) && item.status !== 'archived'
        && knowledgePageKey(item.url) === key && !linked.has(normalizeRadarSummaryId(item.id)))
      .map(item => ({
        id: item.id, kind: 'platform', title: String(item.title || ''),
        url: item.url, note: typeof item.conclusion === 'string' ? item.conclusion : '',
        updatedAt: item.updatedAt, platformResearchId: normalizeRadarSummaryId(item.id), platformOrigin: connectedOrigin,
      })) : [];
    const seen = new Set();
    return [...local, ...remote]
      .filter(item => [item.note, item.aiAnswer, item.quote, item.anchor?.quote].some(text => typeof text === 'string' && text.trim()))
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
      .filter(item => {
        const identity = item.platformResearchId ? `platform:${item.platformResearchId}` : `${item.kind}:${item.id}`;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      })
      .slice(0, Math.max(1, Math.min(3, limit)));
  },
  async listInsights() {
    return (await all('insights')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  },
  async getInsight(id) {
    return get('insights', id);
  },
  async deleteInsight(id) {
    return remove('insights', id);
  },
  async saveAnnotation(annotation) {
    const normalized = normalizeAnnotation({
      ...annotation,
      id: annotation?.id || createUuidV4(),
      updatedAt: new Date().toISOString(),
    });
    if (!normalized) throw new Error('标注格式无效');
    return put('annotations', normalized);
  },
  async listAnnotations() {
    return (await all('annotations')).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  },
  async deleteAnnotation(id) {
    return remove('annotations', id);
  },
  async saveJob(job) {
    return put('jobs', { ...job, updatedAt: new Date().toISOString() });
  },
  async getJob(id) {
    return get('jobs', id);
  },
  async listJobs() {
    return (await all('jobs')).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  },
  async deleteJob(id) {
    return remove('jobs', id);
  },
  async saveTaskInput(id, context) {
    return put('taskInputs', { id, context, updatedAt: new Date().toISOString() });
  },
  async getTaskInput(id) {
    return (await get('taskInputs', id))?.context || null;
  },
  async deleteTaskInput(id) {
    return remove('taskInputs', id);
  },
  async cacheTranslation(key, value) {
    await this.cacheTranslations([{ key, value }]);
    return { id: key, value };
  },
  async cacheTranslations(entries) {
    if (!entries.length) return;
    // One transaction and one retention pass per model batch, rather than
    // opening and scanning the whole cache for every paragraph.
    return withStore('cache', 'readwrite', async (store) => {
      const updatedAt = new Date().toISOString();
      const values = entries.map(({ key, value }) => ({ id: key, value, updatedAt }));
      if (!store) {
        values.forEach(value => fallbackSet('cache', value));
        const all = fallbackAll('cache');
        const stale = all.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(0, Math.max(0, all.length - MAX_TRANSLATION_CACHE_ENTRIES));
        stale.forEach(value => fallbackRemove('cache', value.id));
        return;
      }
      await Promise.all(values.map(value => requestToPromise(store.put(value))));
      const all = await requestToPromise(store.getAll());
      const stale = all.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(0, Math.max(0, all.length - MAX_TRANSLATION_CACHE_ENTRIES));
      await Promise.all(stale.map(value => requestToPromise(store.delete(value.id))));
    }).catch(() => undefined);
  },
  async getCachedTranslations(keys) {
    return withStore('cache', 'readonly', async (store) => {
      const entries = store
        ? await Promise.all(keys.map(key => requestToPromise(store.get(key))))
        : keys.map(key => fallbackGet('cache', key));
      return new Map(keys.map((key, index) => [key, entries[index]?.value ?? null]));
    }).catch(() => new Map(keys.map(key => [key, null])));
  },
  async getCachedTranslation(key) {
    return (await get('cache', key))?.value ?? null;
  },
  async clearCache() {
    const values = await all('cache');
    await Promise.all(values.map((value) => remove('cache', value.id)));
  },
  async clearAll() {
    await Promise.all(STORE_NAMES.map(async (store) => {
      const values = await all(store);
      await Promise.all(values.map((value) => remove(store, value.id)));
    }));
  },
  async exportData() {
    const settings = (await all('settings')).map((setting) => {
      if (setting.id !== 'provider' || !isRecord(setting.value)) return setting;
      return { ...setting, value: withoutSecret(setting.value) };
    });
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      settings,
      sessions: (await all('sessions')).map((value) => withoutSecret(value)),
      insights: (await all('insights')).map((value) => withoutSecret(value)),
      annotations: (await all('annotations')).map((value) => normalizeAnnotation(value)).filter(Boolean).map((value) => withoutSecret(value)),
    };
  },
  async importData(data) {
    if (!data || ![1, 2].includes(data.version)) throw new Error('阅读数据版本不受支持');
    if (data.settings !== undefined && !Array.isArray(data.settings)) throw new Error('阅读设置导入格式无效');
    if (data.sessions !== undefined && !Array.isArray(data.sessions)) throw new Error('阅读会话导入格式无效');
    if (data.insights !== undefined && !Array.isArray(data.insights)) throw new Error('收藏导入格式无效');
    if (data.annotations !== undefined && !Array.isArray(data.annotations)) throw new Error('标注导入格式无效');
    const settings = (data.settings || []).filter(isRecord).slice(0, 200);
    for (const value of settings) {
      if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 120) continue;
      if (value.id === 'provider') {
        // Import files are untrusted input. An exported file intentionally has
        // no key, and a hand-edited file must never be able to inject or
        // overwrite the local model credential.
        const existing = await get('settings', 'provider');
        await put('settings', {
          id: 'provider',
          value: { ...(isRecord(existing?.value) ? existing.value : {}), ...withoutSecret(value.value) },
          updatedAt: value.updatedAt || new Date().toISOString(),
        });
      } else {
        await put('settings', { id: value.id, value: value.value, updatedAt: value.updatedAt || new Date().toISOString() });
      }
    }
    for (const value of (data.sessions || []).filter(isRecord).slice(0, 500)) {
      if (!validPageUrl(value.url)) continue;
      const version = typeof value.version === 'string' ? value.version.slice(0, 256) : null;
      await put('sessions', {
        ...value,
        id: typeof value.id === 'string' && value.id.length <= 500 ? value.id : sessionKey(value.url, version),
        url: value.url,
        version,
        title: typeof value.title === 'string' ? value.title.slice(0, 500) : value.url,
        updatedAt: value.updatedAt || new Date().toISOString(),
      });
    }
    for (const value of (data.insights || []).filter(isRecord).slice(0, 500)) {
      if (!validPageUrl(value.url) || typeof value.quote !== 'string' || !value.quote.trim()) continue;
      await put('insights', {
        ...value,
        id: typeof value.id === 'string' && value.id.length <= 200 ? value.id : createUuidV4(),
        title: typeof value.title === 'string' ? value.title.slice(0, 500) : value.url,
        quote: value.quote.slice(0, 20_000),
        note: typeof value.note === 'string' ? value.note.slice(0, 20_000) : '',
        aiAnswer: typeof value.aiAnswer === 'string' ? value.aiAnswer.slice(0, 20_000) : '',
        tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.slice(0, 80)).slice(0, 10) : [],
        updatedAt: value.updatedAt || new Date().toISOString(),
      });
    }
    for (const value of (data.annotations || []).filter(isRecord).slice(0, 500)) {
      const normalized = normalizeAnnotation(value);
      if (normalized) await put('annotations', normalized);
    }
  },
};
