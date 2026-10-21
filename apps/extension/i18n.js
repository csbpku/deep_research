import english from './locales/en.json' with { type: 'json' };

export function resolveUiLanguage(value) {
  return /^zh(?:-|$)/iu.test(String(value || '')) ? 'zh-CN' : 'en';
}

let language = resolveUiLanguage(globalThis.navigator?.language || 'en');
export const getUiLanguage = () => language;

export function t(message, ...values) {
  const template = language === 'en' ? english[message] || message : message;
  return template.replace(/\{(\d+)\}/gu, (_, index) => String(values[Number(index)] ?? ''));
}

export async function initializeLocale() {
  const stored = await globalThis.chrome?.storage?.local?.get?.('readerUiLanguage').catch(() => ({}));
  language = resolveUiLanguage(stored?.readerUiLanguage && stored.readerUiLanguage !== 'system' ? stored.readerUiLanguage : globalThis.navigator?.language || 'en');
  if (globalThis.document) {
    document.documentElement.lang = language;
    document.title = t(document.title);
  }
  return stored?.readerUiLanguage || 'system';
}

export async function setUiLanguage(value) {
  await chrome.storage.local.set({ readerUiLanguage: ['en', 'zh-CN'].includes(value) ? value : 'system' });
}

// This is used only with extension-authored static markup. User quotations and
// model output are never passed through the UI catalogue.
export function localizedMarkup(markup) {
  return markup.replace(/>([^<>]*[\u3400-\u9fff][^<>]*)</gu, (_, text) => `>${t(text)}<`)
    .replace(/(aria-label|title|placeholder)="([^"]*)"/gu, (_, attribute, text) => `${attribute}="${t(text)}"`);
}
