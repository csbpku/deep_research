// Translation targets are independent of interface and chat reply languages.
export const TRANSLATION_LANGUAGES = [
  { value: 'zh-CN', label: '简体中文', short: '中文' },
  { value: 'zh-TW', label: '繁體中文', short: '繁中' },
  { value: 'en', label: 'English', short: 'EN' },
  { value: 'ja', label: '日本語', short: 'JA' },
  { value: 'ko', label: '한국어', short: 'KO' },
  { value: 'fr', label: 'Français', short: 'FR' },
  { value: 'de', label: 'Deutsch', short: 'DE' },
  { value: 'es', label: 'Español', short: 'ES' },
  { value: 'pt', label: 'Português', short: 'PT' },
  { value: 'it', label: 'Italiano', short: 'IT' },
  { value: 'ru', label: 'Русский', short: 'RU' },
  { value: 'ar', label: 'العربية', short: 'AR' },
];
export function normalizeTranslationLanguage(value) {
  return TRANSLATION_LANGUAGES.some(item => item.value === value) ? value : 'interface';
}
export function resolveTranslationLanguage(value, interfaceLanguage) {
  const normalized = normalizeTranslationLanguage(value);
  return normalized === 'interface' ? (interfaceLanguage === 'zh-CN' ? 'zh-CN' : 'en') : normalized;
}
