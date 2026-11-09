/**
 * The Reader can either replace the page text with its translation or keep the
 * source and show the translation underneath it (bilingual reading). This
 * module stays free of browser APIs so the settings surface, the content
 * script and the unit tests agree on one rule.
 *
 * @typedef {'replace' | 'stacked'} TranslationLayout
 */

/** The `chrome.storage.local` key shared by the panel and the content script. */
export const TRANSLATION_LAYOUT_KEY = 'readerTranslationLayout';

/** @type {readonly TranslationLayout[]} */
export const TRANSLATION_LAYOUTS = Object.freeze(['replace', 'stacked']);

const REPLACE = 'replace';
const STACKED = 'stacked';

/**
 * Anything that is not an explicit layout falls back to `replace`: a stale
 * value from an older build, a typo, or a missing key must keep the behavior
 * users already had instead of silently changing the page.
 *
 * @param {unknown} value
 * @returns {TranslationLayout}
 */
export function normalizeTranslationLayout(value) {
  if (typeof value !== 'string') return REPLACE;
  const normalized = value.trim().toLowerCase();
  return normalized === STACKED ? STACKED : REPLACE;
}

/**
 * The preference has no `system`-style member, so resolving it only normalizes
 * the stored value. The separate name keeps call sites readable and leaves room
 * for a future mode that has to be resolved against the page.
 *
 * @param {unknown} preference
 * @returns {TranslationLayout}
 */
export function resolveTranslationLayout(preference) {
  return normalizeTranslationLayout(preference);
}

/**
 * Code blocks and table cells must keep the whole-block replacement. Stacking a
 * `<pre>` would duplicate scroll containers, and a stacked cell would add a
 * second row of content inside the table grid and break its layout.
 *
 * @param {{ layout?: unknown, tagName?: unknown, isTable?: unknown, isCode?: unknown }} [block]
 * @returns {TranslationLayout}
 */
export function layoutForBlock({ layout, tagName, isTable, isCode } = {}) {
  if (normalizeTranslationLayout(layout) !== STACKED) return REPLACE;
  const tag = typeof tagName === 'string' ? tagName.trim().toLowerCase() : '';
  if (isCode === true || isTable === true) return REPLACE;
  if (tag === 'pre' || tag === 'code' || tag === 'td' || tag === 'th') return REPLACE;
  return STACKED;
}
