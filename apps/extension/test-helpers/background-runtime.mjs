import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as core from '../reader-core.js';
import { readerStore } from '../reader-store.js';
import { activationReason } from '../activation.js';
import { isBundledDemoUrl, requestDemoContext } from '../reader-demo.js';
import { GLOSSARY_MAX_PROMPT_CHARS, glossaryPrompt as buildGlossaryPrompt, parseGlossary } from '../glossary.js';
import { createUsageRecorder } from '../usage-persistence.js';
import { estimateTranslation } from '../cost-estimate.js';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gmu, '');
const event = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); } });

function storageArea() {
  const values = {};
  return {
    values,
    async get(keys) {
      if (keys === null) return { ...values };
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter(key => key in values).map(key => [key, values[key]]));
    },
    async set(next) { Object.assign(values, next); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
  };
}

// Run the complete worker listener/executor code with an in-memory browser.
// The real Reader store and translation implementation remain in use unless a
// test replaces one dependency explicitly. No test invokes a real provider.
export function createBackgroundHarness(overrides = {}) {
  const emitted = [], sent = [], injected = [];
  const tabs = new Map([[1, { id: 1, windowId: 1, active: true, url: 'https://example.test/article' }]]);
  const chrome = {
    runtime: {
      id: 'reader-unit', onMessage: event(), onInstalled: event(), onStartup: event(),
      getURL: path => `chrome-extension://reader-unit/${path}`,
      async sendMessage(message) { emitted.push(message); },
    },
    storage: { local: storageArea(), session: storageArea(), onChanged: event() },
    alarms: { async create() {}, onAlarm: event() },
    scripting: { async executeScript(request) { injected.push(request); } },
    sidePanel: { async open() {} },
    tabs: {
      onActivated: event(), onUpdated: event(), onRemoved: event(),
      async get(id) { if (!tabs.has(id)) throw new Error('closed tab'); return tabs.get(id); },
      async query() { return [...tabs.values()].filter(tab => tab.active); },
      async sendMessage(tabId, message) {
        sent.push({ tabId, message });
        if (message.type === 'deep-research:apply-translations') {
          return { ok: true, appliedIds: message.translations.map(item => item.id) };
        }
      },
    },
    windows: { onRemoved: event() },
    action: { onClicked: event() },
    contextMenus: { onClicked: event(), update(_id, _patch, callback) { callback?.(); } },
  };
  const globals = {
    ...core, estimateTranslation, readerStore, activationReason, isBundledDemoUrl, requestDemoContext,
    GLOSSARY_MAX_PROMPT_CHARS, buildGlossaryPrompt, parseGlossary, createUsageRecorder,
    chrome, console, AbortController, DOMException, URL, crypto: globalThis.crypto,
    setTimeout, clearTimeout, queueMicrotask,
    t: (message, ...values) => message.replace(/\{(\d+)\}/gu, (_, index) => String(values[Number(index)] ?? '')),
    initializeLocale: async () => {},
    DEFAULT_WEB_APP_URL: 'https://platform.test',
    ...overrides,
  };
  const api = vm.runInNewContext(`${source}\n({ executeTranslationJob, resumePersistedTranslationJobs, activateTabForReading, markReadingWindow });`, globals);
  const dispatch = message => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not respond')), 1000);
    const respond = result => { clearTimeout(timer); resolve(result); };
    for (const listener of chrome.runtime.onMessage.listeners) {
      listener(message, { id: chrome.runtime.id, url: chrome.runtime.getURL('sidepanel.html') }, respond);
    }
  });
  return { ...api, dispatch, chrome, globals, tabs, emitted, sent, injected };
}

export async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('worker state did not settle');
}
