// Translation targets are independent of interface and chat reply languages.
// `code` is the one-or-two-character form the compact composer chip uses.
export const TRANSLATION_LANGUAGES = [
  { value: 'zh-CN', label: '简体中文', short: '中文', code: '中' },
  { value: 'zh-TW', label: '繁體中文', short: '繁中', code: '繁' },
  { value: 'en', label: 'English', short: 'EN', code: 'EN' },
  { value: 'ja', label: '日本語', short: 'JA', code: 'JA' },
  { value: 'ko', label: '한국어', short: 'KO', code: 'KO' },
  { value: 'fr', label: 'Français', short: 'FR', code: 'FR' },
  { value: 'de', label: 'Deutsch', short: 'DE', code: 'DE' },
  { value: 'es', label: 'Español', short: 'ES', code: 'ES' },
  { value: 'pt', label: 'Português', short: 'PT', code: 'PT' },
  { value: 'it', label: 'Italiano', short: 'IT', code: 'IT' },
  { value: 'ru', label: 'Русский', short: 'RU', code: 'RU' },
  { value: 'ar', label: 'العربية', short: 'AR', code: 'AR' },
];
export function normalizeTranslationLanguage(value) {
  return TRANSLATION_LANGUAGES.some(item => item.value === value) ? value : 'interface';
}
export function resolveTranslationLanguage(value, interfaceLanguage) {
  const normalized = normalizeTranslationLanguage(value);
  return normalized === 'interface' ? (interfaceLanguage === 'zh-CN' ? 'zh-CN' : 'en') : normalized;
}
