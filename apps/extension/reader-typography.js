/**
 * Reading typography is a three-step scale, not a free-form slider. Three
 * presets cover the range the Reader actually needs, and each one is a fixed
 * set of values that can be reviewed and tested as a whole instead of an
 * infinite matrix of sizes and leadings.
 *
 * The module is deliberately browser-free: the React provider, the settings
 * surface and the unit test agree on one rule, and the test can prove the
 * default step against the design-system tokens without a DOM.
 *
 * @typedef {'compact' | 'comfortable' | 'large'} ReaderTypeScale
 */

/** The `chrome.storage.local` key shared by the panel and the settings surface. */
export const READER_TYPE_SCALE_KEY = 'readerTypeScale';

/** Ordered from the densest to the most open step. */
/** @type {readonly ReaderTypeScale[]} */
export const READER_TYPE_SCALES = Object.freeze(['compact', 'comfortable', 'large']);

const DEFAULT_TYPE_SCALE = 'comfortable';

/**
 * One preset is one row of CSS custom properties. Only the keys a step has to
 * override live here; every other reading dimension keeps coming from the
 * design-system tokens, so this table cannot drift into a second type system.
 *
 * `comfortable` is the step the Reader shipped with before the scale existed
 * (15px body, 1.8 leading, headings 16px apart), so it must stay pixel-identical
 * to the token fallbacks in `reader-theme.tsx` and `reader-ui.css`; the unit
 * test pins that equivalence against `tokens.json`.
 *
 * `--reader-markdown-heading-gap` is the space above a heading, and the
 * stylesheet halves it for the space below. 16px therefore reproduces the
 * previous `var(--reader-space-4) 0 var(--reader-space-2)` margin exactly.
 */
const TYPE_SCALE_VARIABLES = Object.freeze({
  compact: Object.freeze({
    '--reader-reading-size': '14px',
    '--reader-reading-leading': '1.7',
    '--reader-markdown-heading-gap': '12px',
  }),
  comfortable: Object.freeze({
    '--reader-reading-size': '15px',
    '--reader-reading-leading': '1.8',
    '--reader-markdown-heading-gap': '16px',
  }),
  large: Object.freeze({
    '--reader-reading-size': '17px',
    '--reader-reading-leading': '1.9',
    '--reader-markdown-heading-gap': '24px',
  }),
});

/**
 * A stale value from an older build, a typo or a missing key must never leave
 * the Reader at a size the user cannot explain, so anything unrecognised means
 * the default step. Case and surrounding whitespace are tolerated because the
 * value can arrive from a hand-edited settings export.
 *
 * @param {unknown} value
 * @returns {ReaderTypeScale}
 */
export function normalizeTypeScale(value) {
  if (typeof value !== 'string') return DEFAULT_TYPE_SCALE;
  const normalized = value.trim().toLowerCase();
  return READER_TYPE_SCALES.includes(normalized) ? normalized : DEFAULT_TYPE_SCALE;
}

/**
 * Resolve a stored value to the exact set of custom properties the document
 * needs. A fresh object is returned so no caller can mutate the frozen table,
 * and the provider can publish the keys without filtering them first.
 *
 * @param {unknown} scale
 * @returns {Record<string, string>}
 */
export function typeScaleVariables(scale) {
  return { ...TYPE_SCALE_VARIABLES[normalizeTypeScale(scale)] };
}
