/*
 * Reading-scope selection for the Reader content script.
 *
 * This file is concatenated ahead of content.js by scripts/sync-static.mjs, so
 * every injection path (background.js and the e2e harnesses) receives it in the
 * same classic script. It exposes globalThis.__deepResearchReadingScope and,
 * when loaded as a CommonJS module in Node tests, module.exports.
 *
 * Why this exists: picking the first <article>/<main> misses the body on pages
 * that use several <main> elements (VitePress puts the title in one and the
 * article in another). Instead of trusting one container, every candidate is
 * scored by prose outside links and navigation, and disjoint strong candidates
 * are merged. Coverage is measured against the whole document, independently of
 * the selection, so a missed body is reported instead of silently dropped.
 */
(function (scope) {
  'use strict';

  const READING_BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,dt,dd,figcaption,caption,.sd-k,.sd-kv';
  const CANDIDATE_SELECTOR = [
    'article',
    'main',
    '[role="main"]',
    '[itemprop="articleBody"]',
    // Documentation generators that wrap the article in a non-semantic element.
    '.vp-doc',
    '.theme-doc-markdown',
    '.md-content',
    '.sl-markdown-content',
    '.markdown-body',
    '#readme',
  ].join(',');
  const EXCLUDED_SELECTOR = [
    'nav', 'header', 'footer', 'aside', 'form', 'button',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[aria-hidden="true"]', '[contenteditable="true"]',
    'script', 'style', 'noscript', 'svg', 'template',
    // Reader output must never vote for a reading root or inflate coverage.
    // Design hosts include the controls and image-translation wrappers; the
    // original article nodes remain eligible even when hidden by translation.
    '[data-deep-research-translation]', '[data-deep-research-design-host]',
    '[data-deep-research-annotation-highlight]',
  ].join(',');
  const EXCLUDED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'TEXTAREA', 'SELECT', 'INPUT']);
  // A candidate must carry at least this much prose to be a reading root.
  const MIN_SCOPE_CHARS = 40;
  // Another disjoint candidate joins when it carries this share of the best one.
  const SECONDARY_RATIO = 0.15;
  // <main><article>: the article replaces its enclosing main when it carries
  // nearly all of the prose, which keeps the historical single-article result.
  const ARTICLE_SHARE = 0.85;
  // Coverage below this, with more than PARTIAL_MIN_MISSING_CHARS unread, is partial.
  const PARTIAL_COVERAGE = 0.6;
  const PARTIAL_MIN_MISSING_CHARS = 1500;
  const DOCUMENT_POSITION_FOLLOWING = 4;

  function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function isExcluded(element) {
    return Boolean(element.closest && element.closest(EXCLUDED_SELECTOR));
  }

  // Prose inside `node`: text outside excluded regions and outside links.
  // Links are navigation in documentation sidebars and table-of-contents lists.
  function proseLength(node) {
    let total = 0;
    const walk = (current) => {
      for (const child of Array.from(current.childNodes || [])) {
        if (child.nodeType === 3) {
          total += clean(child.nodeValue).length;
          continue;
        }
        if (child.nodeType !== 1) continue;
        if (EXCLUDED_TAGS.has(child.tagName) || (child.matches && child.matches(EXCLUDED_SELECTOR))) continue;
        if (child.tagName === 'A') continue;
        walk(child);
      }
    };
    walk(node);
    return total;
  }

  function byDocumentOrder(a, b) {
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function pageScope(body, totalChars) {
    return {
      roots: [body],
      mode: 'page',
      coverage: 1,
      totalChars,
      coveredChars: totalChars,
      partial: false,
    };
  }

  // Choose the reading roots for a document. Returns plain data so the caller
  // can decide how to present it; never throws on odd documents.
  function selectReadingRoots(doc) {
    const body = doc.body || doc.documentElement;
    const totalChars = proseLength(body);
    const candidates = Array.from(doc.querySelectorAll(CANDIDATE_SELECTOR))
      .filter((element) => !isExcluded(element))
      .map((element) => ({
        element,
        chars: proseLength(element),
        hasHeading: Array.from(element.querySelectorAll('h1')).some((heading) => !isExcluded(heading)),
      }))
      .filter((candidate) => candidate.chars > 0);
    // Stable sort: equal scores keep document order, so an outer container
    // wins over an inner one that holds the same text.
    candidates.sort((a, b) => b.chars - a.chars);
    if (!candidates.length || candidates[0].chars < MIN_SCOPE_CHARS) {
      return pageScope(body, totalChars);
    }
    const best = candidates[0].chars;
    const selected = [];
    for (const candidate of candidates) {
      const index = selected.findIndex((chosen) => (
        chosen.element.contains(candidate.element) || candidate.element.contains(chosen.element)
      ));
      if (index !== -1) {
        const chosen = selected[index];
        const articleInside = candidate.element.tagName === 'ARTICLE' && chosen.element.contains(candidate.element);
        if (articleInside && candidate.chars >= chosen.chars * ARTICLE_SHARE) selected[index] = candidate;
        continue;
      }
      const strong = candidate.chars >= best * SECONDARY_RATIO;
      // A short title region with a heading still belongs to the article.
      const titled = candidate.hasHeading && candidate.chars >= MIN_SCOPE_CHARS;
      if (!strong && !titled) continue;
      selected.push(candidate);
    }
    const roots = selected.map((candidate) => candidate.element).sort(byDocumentOrder);
    const coveredChars = selected.reduce((sum, candidate) => sum + candidate.chars, 0);
    const coverage = totalChars > 0 ? Math.min(1, coveredChars / totalChars) : 1;
    const missing = Math.max(0, totalChars - coveredChars);
    return {
      roots,
      mode: 'scoped',
      coverage: Math.round(coverage * 1000) / 1000,
      totalChars,
      coveredChars,
      partial: coverage < PARTIAL_COVERAGE && missing > PARTIAL_MIN_MISSING_CHARS,
    };
  }

  const api = {
    READING_BLOCK_SELECTOR,
    CANDIDATE_SELECTOR,
    EXCLUDED_SELECTOR,
    selectReadingRoots,
    proseLength,
  };
  scope.__deepResearchReadingScope = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
