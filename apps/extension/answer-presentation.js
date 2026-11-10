/**
 * Presentation helpers that describe how well an answer is grounded in the page
 * it was produced from.
 *
 * This module is intentionally DOM-free and storage-free: the side panel owns
 * rendering and clipboard access, so coverage can be computed in a render call
 * and unit-tested without a browser. UI copy is not hard-coded into markup here
 * — callers inject the interface translator through `options.translate` so the
 * same note follows the Reader UI language.
 */

/**
 * Normalise text the same way `compactAnswerText` in `reader-core.js` does.
 *
 * It is duplicated on purpose instead of exported from `reader-core.js`:
 * that module opens the IndexedDB reader store at module scope, and this helper
 * is meant to stay importable from lightweight presentation tests. Keep the two
 * implementations in sync — a quote that a block match accepts here must also
 * be locatable by `sourceAnchorForQuote` there.
 */
function compactText(value) {
  return String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .replace(/\s+/gu, ' ')
    .trim();
}

function formatMessage(message, ...values) {
  return String(message).replace(/\{(\d+)\}/gu, (_, index) => String(values[Number(index)] ?? ''));
}

function evidenceQuotes(structured) {
  const items = Array.isArray(structured)
    ? structured
    : Array.isArray(structured?.evidence) ? structured.evidence : [];
  return items
    .map((item) => compactText(typeof item === 'string' ? item : item?.quote))
    .filter(Boolean);
}

function blockTexts(context) {
  const blocks = Array.isArray(context?.blocks) ? context.blocks : [];
  return blocks
    .map((block) => compactText(typeof block === 'string' ? block : block?.text))
    .filter(Boolean);
}

/**
 * Summarise citation coverage for the answer currently on screen.
 *
 * `evidenceBlocks` counts distinct source paragraphs that still contain one of
 * the answer's quotes, using the same whitespace-normalised matching as
 * `sourceAnchorForQuote`. `blockCount` is 0 when the page context has no block
 * segmentation, which callers must treat as "unknown" rather than "no
 * paragraphs".
 *
 * @param {{ body?: string, blocks?: Array<{ text?: string } | string>, blockCount?: number,
 *   bodyTruncated?: boolean, blocksTruncated?: boolean, coverageWarning?: string }} context
 * @param {{ evidence?: Array<{ quote?: string }> } | Array<{ quote?: string }>} structured
 * @param {{ translate?: (message: string, ...values: unknown[]) => string }} [options]
 * @returns {{ evidenceCount: number, evidenceBlocks: number, blockCount: number, truncated: boolean, note: string }}
 */
export function answerCoverage(context = {}, structured = {}, options = {}) {
  const translate = typeof options?.translate === 'function' ? options.translate : formatMessage;
  const page = context && typeof context === 'object' ? context : {};
  const quotes = evidenceQuotes(structured);
  const blocks = blockTexts(page);
  const blockCount = Math.max(0, Number(page.blockCount) || blocks.length || 0);
  // `coverageWarning` is produced by `translationCoverageWarning` in the side
  // panel and only ever reports a bounded page context, so it is a truncation
  // signal rather than a generic warning.
  const truncated = Boolean(page.bodyTruncated || page.blocksTruncated || page.coverageWarning);

  let evidenceBlocks = 0;
  if (blocks.length) {
    const covered = new Set();
    for (const quote of quotes) {
      blocks.forEach((text, index) => {
        if (text.includes(quote)) covered.add(index);
      });
    }
    evidenceBlocks = covered.size;
  } else {
    // Without paragraph segmentation the excerpt itself is the only observable
    // unit, so each quote still found in the body counts as covered.
    const matched = new Set();
    const body = compactText(page.body);
    for (const quote of quotes) if (body.includes(quote)) matched.add(quote);
    evidenceBlocks = matched.size;
  }

  let note;
  if (!quotes.length) {
    note = truncated
      ? translate('本次回答没有可核对的原文证据；正文已按上限截取')
      : translate('本次回答没有可核对的原文证据');
  } else if (truncated) {
    note = translate('证据覆盖 {0} 段；正文已按上限截取，结论未覆盖全文', evidenceBlocks);
  } else if (blockCount) {
    note = translate('证据覆盖 {0} 段，正文共 {1} 段', evidenceBlocks, blockCount);
  } else {
    note = translate('证据覆盖 {0} 段，正文段数未知', evidenceBlocks);
  }

  return { evidenceCount: quotes.length, evidenceBlocks, blockCount, truncated, note };
}
