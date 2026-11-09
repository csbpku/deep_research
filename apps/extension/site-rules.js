/**
 * Per-site translation behaviour for the Reader.
 *
 * The sidebar, the content script and the settings surface all have to answer
 * the same question ("may this page be translated without asking?"), so the
 * decision lives in one dependency-free module instead of being reimplemented
 * per surface. Nothing here touches the DOM or storage: callers persist the
 * plain `{ host: mode }` object under `SITE_RULES_KEY`.
 *
 * @typedef {'always' | 'never' | 'ask'} SiteRuleMode
 * @typedef {'exact' | 'suffix' | 'default'} SiteRuleMatch
 * @typedef {{ [host: string]: SiteRuleMode }} SiteRules
 * @typedef {{ host: string, mode: SiteRuleMode, matched: SiteRuleMatch }} SiteRuleResolution
 */

/** The modes a user can pick. `ask` is the default and is never persisted. */
export const SITE_RULE_MODES = Object.freeze(['always', 'never', 'ask']);

/** The `chrome.storage.local` key holding the `{ host: mode }` map. */
export const SITE_RULES_KEY = 'readerSiteRules';

/**
 * A hard cap keeps a corrupted or hand-edited settings blob from bloating
 * storage and from turning every page load into a large map scan.
 */
const MAX_SITE_RULES = 500;

/**
 * The wildcard form of a rule key, e.g. `*.example.com`. It covers subdomains
 * only, so the bare domain stays available for its own exact rule.
 */
const WILDCARD_PREFIX = '*';

const SITE_RULE_MODE_SET = new Set(SITE_RULE_MODES);

/**
 * Assignment through `__proto__` or a name inherited from `Object.prototype`
 * is the classic way object-shaped settings pollute every object in the page.
 * `__proto__` is already rejected by the hostname grammar (underscores are not
 * host characters), but `constructor` is a syntactically valid host, so keep
 * an explicit deny list instead of trusting the grammar alone.
 */
const UNSAFE_RULE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// One DNS label is 1-63 characters and may not start or end with a hyphen.
// IDN input is punycoded by the URL parser before this runs, so plain ASCII is
// enough here and keeps the accepted set easy to audit.
const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;
const IPV6_HOSTNAME_PATTERN = /^\[[0-9a-f:.]+\]$/u;

// `scheme://` is hierarchical; anything else with a scheme colon is not a web
// page. A colon followed by digits is a port, not a scheme, which is what
// keeps `example.com:8443` usable as bare input.
const HIERARCHICAL_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//iu;
const OTHER_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:(?!\d)/iu;

// `www.` is a presentation prefix, not a different site. Rules are stored
// against the canonical host so a rule set on one form also applies to the
// other; otherwise "always translate example.com" would silently miss
// www.example.com and vice versa.
const WWW_PREFIX = 'www.';

const SITE_RULE_DESCRIPTIONS = Object.freeze({
  always: Object.freeze({
    mode: 'always',
    label: 'Always translate',
    description: 'Translate pages on this site automatically.',
  }),
  never: Object.freeze({
    mode: 'never',
    label: 'Never translate',
    description: 'Leave pages on this site in their original language.',
  }),
  ask: Object.freeze({
    mode: 'ask',
    label: 'Ask every time',
    description: 'Ask before translating a page on this site.',
  }),
});

/**
 * Turn a URL or a hand-typed host into the lower-case hostname used as a rule
 * key. Invalid input becomes `''` rather than throwing, because this runs on
 * URLs coming from the browser as well as on pasted settings.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeHost(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';

  let hostname;
  const hierarchical = HIERARCHICAL_SCHEME_PATTERN.exec(trimmed);
  try {
    if (hierarchical) {
      const scheme = hierarchical[1].toLowerCase();
      // Reader only reads http(s) pages. A rule for a chrome://, file:// or
      // view-source: host would never be consulted and only confuses users.
      if (scheme !== 'http' && scheme !== 'https') return '';
      hostname = new URL(trimmed).hostname;
    } else {
      // `mailto:`, `javascript:` and `chrome:` have no authority component and
      // must not be mistaken for a host named "mailto".
      if (OTHER_SCHEME_PATTERN.test(trimmed)) return '';
      // Protocol-relative input (`//example.com/x`) is common when a caller
      // passes a URL fragment; treat it like a bare host with a path.
      hostname = new URL(`http://${trimmed.replace(/^\/+/u, '')}`).hostname;
    }
  } catch {
    return '';
  }

  return cleanHostname(hostname);
}

/**
 * Normalize arbitrary stored input into a clean `{ host: mode }` map.
 *
 * Accepted shapes are a plain object map, an array of `[host, mode]` pairs and
 * an array of `{ host, mode }` records. Everything else yields `{}`. Hosts are
 * canonicalized (case, trailing dot, leading `www.`) so one site has one key.
 * Invalid hosts and modes are dropped, `ask` is dropped because it is the
 * default, and later entries win so a duplicated host behaves like a correction.
 *
 * @param {unknown} value
 * @returns {SiteRules}
 */
export function normalizeSiteRules(value) {
  const rules = {};
  for (const [rawHost, rawMode] of siteRuleEntries(value)) {
    const host = normalizeRuleHost(rawHost);
    if (!host || isUnsafeRuleKey(host)) continue;
    const mode = normalizeSiteRuleMode(rawMode);
    if (!mode || mode === 'ask') continue;
    rules[host] = mode;
  }

  // `Object.keys` follows insertion order for host-shaped keys, so the cap
  // drops the newest overflow instead of reshuffling the rules a user sees.
  const overflow = Object.keys(rules).slice(MAX_SITE_RULES);
  for (const host of overflow) delete rules[host];
  return rules;
}

/**
 * Resolve the rule that applies to a page URL.
 *
 * Exact rules win over wildcards. Wildcards use the most specific matching
 * suffix (`*.a.example.com` beats `*.example.com`). A `www.` page is compared
 * with the canonical host, so a rule for `example.com` also covers
 * `www.example.com`. Non-http(s) URLs and empty values are always `default`.
 *
 * The returned `host` is the page host as normalized (a `www.` prefix is
 * preserved for display); rule keys are canonical, which is the form
 * `setSiteRule` accepts.
 *
 * @param {unknown} url
 * @param {unknown} rules
 * @returns {SiteRuleResolution}
 */
export function siteRuleFor(url, rules) {
  const host = normalizeHost(urlString(url));
  if (!host) return { host: '', mode: 'ask', matched: 'default' };

  const normalizedRules = normalizeSiteRules(rules);
  // Wildcard keys keep their base as typed (a wildcard for `*.www.example.com`
  // is a different set of pages), so keep the raw host for suffix matching and
  // the canonical host for exact matching.
  const exactMode = normalizedRules[canonicalSiteHost(host)];
  if (exactMode) return { host, mode: exactMode, matched: 'exact' };

  const suffixMode = bestWildcardMode(host, normalizedRules);
  if (suffixMode) return { host, mode: suffixMode, matched: 'suffix' };

  return { host, mode: 'ask', matched: 'default' };
}

/**
 * Return a new rule map with one host changed. The input object is never
 * mutated, so callers can keep the previous map for comparison or undo.
 *
 * Setting `ask` deletes the entry: the default does not need storage. Invalid
 * hosts or modes leave the map unchanged rather than throwing, because the
 * mode may come from an older build or a hand-edited settings file.
 *
 * @param {unknown} rules
 * @param {unknown} host
 * @param {unknown} mode
 * @returns {SiteRules}
 */
export function setSiteRule(rules, host, mode) {
  const next = normalizeSiteRules(rules);
  const normalizedHost = normalizeRuleHost(host);
  const normalizedMode = normalizeSiteRuleMode(mode);
  if (!normalizedHost || isUnsafeRuleKey(normalizedHost) || !normalizedMode) return next;

  if (normalizedMode === 'ask') {
    delete next[normalizedHost];
  } else {
    next[normalizedHost] = normalizedMode;
  }
  return next;
}

/**
 * Stable, translatable description of a mode for the settings UI. The labels
 * are English fallbacks; the panel is responsible for localizing them, so this
 * module never emits Chinese copy.
 *
 * @param {unknown} mode
 * @returns {Readonly<{ mode: SiteRuleMode, label: string, description: string }>}
 */
export function describeSiteRule(mode) {
  return SITE_RULE_DESCRIPTIONS[normalizeSiteRuleMode(mode) || 'ask'];
}

/**
 * Strip a single trailing dot (the FQDN form) and validate the rest.
 *
 * @param {string} hostname
 * @returns {string}
 */
function cleanHostname(hostname) {
  let host = String(hostname).toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  // 253 is the DNS limit for the textual form; IPv6 literals are much shorter.
  if (!host || host.length > 253) return '';
  if (IPV6_HOSTNAME_PATTERN.test(host)) return host;
  return HOSTNAME_PATTERN.test(host) ? host : '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeRuleHost(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('*.')) {
    const base = normalizeHost(trimmed.slice(2));
    return base ? `*.${base}` : '';
  }
  const host = normalizeHost(trimmed);
  return host ? canonicalSiteHost(host) : '';
}

/**
 * @param {string} host
 * @returns {string}
 */
function canonicalSiteHost(host) {
  return host.startsWith(WWW_PREFIX) ? host.slice(WWW_PREFIX.length) : host;
}

/**
 * @param {unknown} value
 * @returns {SiteRuleMode | null}
 */
function normalizeSiteRuleMode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SITE_RULE_MODE_SET.has(normalized) ? normalized : null;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isUnsafeRuleKey(host) {
  return UNSAFE_RULE_KEYS.has(host) || Object.hasOwn(Object.prototype, host);
}

/**
 * Flatten the supported input shapes into `[host, mode]` pairs without
 * touching inherited properties. Getters are read one by one so a hostile
 * object cannot abort the whole normalization.
 *
 * @param {unknown} value
 * @returns {Array<[unknown, unknown]>}
 */
function siteRuleEntries(value) {
  if (Array.isArray(value)) {
    const entries = [];
    for (const item of value) {
      if (Array.isArray(item)) {
        entries.push([item[0], item[1]]);
      } else if (item && typeof item === 'object') {
        try {
          entries.push([item.host, item.mode]);
        } catch {
          // A throwing getter makes this entry unusable; skip it.
        }
      }
    }
    return entries;
  }
  if (!value || typeof value !== 'object') return [];

  const entries = [];
  for (const key of Object.keys(value)) {
    try {
      entries.push([key, value[key]]);
    } catch {
      // See above: untrusted getters must not break normalization.
    }
  }
  return entries;
}

/**
 * Find the most specific matching `*.base` rule. A wildcard deliberately does
 * not match its own base domain: `*.example.com` covers `a.example.com` but
 * leaves `example.com` to its exact rule.
 *
 * @param {string} host
 * @param {SiteRules} rules
 * @returns {SiteRuleMode | ''}
 */
function bestWildcardMode(host, rules) {
  let mode = '';
  let bestBaseLength = -1;
  for (const [key, candidate] of Object.entries(rules)) {
    if (!key.startsWith(`${WILDCARD_PREFIX}.`)) continue;
    const base = key.slice(2);
    if (!host.endsWith(`.${base}`)) continue;
    if (base.length > bestBaseLength) {
      bestBaseLength = base.length;
      mode = candidate;
    }
  }
  return mode;
}

/**
 * Accept a string, a `URL`, or a location-like object with an `href`.
 *
 * @param {unknown} value
 * @returns {string}
 */
function urlString(value) {
  if (typeof value === 'string') return value.trim();
  try {
    if (value && typeof value === 'object' && typeof value.href === 'string') {
      return value.href.trim();
    }
  } catch {
    // Hostile getter: treat it as an unusable URL.
  }
  return '';
}
