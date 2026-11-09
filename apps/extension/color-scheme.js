/**
 * The Reader follows the platform, the operating system, or an explicit user
 * choice. This module stays free of browser APIs so the React panel, the
 * settings surface and the unit test agree on one rule.
 *
 * @typedef {'light' | 'dark'} ReaderColorScheme
 * @typedef {'light' | 'dark' | 'system'} ReaderColorSchemePreference
 */

/** The `chrome.storage.local` key shared by the panel and the content script. */
export const READER_COLOR_SCHEME_KEY = 'readerColorScheme';

/** @type {readonly ReaderColorSchemePreference[]} */
export const READER_COLOR_SCHEME_PREFERENCES = Object.freeze(['light', 'dark', 'system']);

/**
 * Anything that is not an explicit scheme means "follow the system": a stale
 * value from an older build, a typo, or a missing key must never leave the
 * Reader on a palette the user cannot explain.
 *
 * @param {unknown} value
 * @returns {ReaderColorSchemePreference}
 */
export function normalizeColorSchemePreference(value) {
  if (typeof value !== 'string') return 'system';
  const normalized = value.trim().toLowerCase();
  return READER_COLOR_SCHEME_PREFERENCES.includes(normalized) ? normalized : 'system';
}

/**
 * @param {unknown} preference
 * @returns {boolean}
 */
export function shouldFollowSystem(preference) {
  return normalizeColorSchemePreference(preference) === 'system';
}

/**
 * Resolve the stored preference against the current operating-system setting.
 *
 * @param {unknown} preference
 * @param {unknown} systemPrefersDark `matchMedia('(prefers-color-scheme: dark)').matches`
 * @returns {ReaderColorScheme}
 */
export function resolveColorScheme(preference, systemPrefersDark) {
  const normalized = normalizeColorSchemePreference(preference);
  if (normalized === 'system') return systemPrefersDark === true ? 'dark' : 'light';
  return normalized;
}
