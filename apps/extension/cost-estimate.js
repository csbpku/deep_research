// Pre-flight cost estimation for Reader translation and question answering.
//
// Users bring their own API key, so the only question they ask before a long
// page translation is "roughly how much is this going to cost me?". Answering
// that before the request is sent means we must be able to reproduce *how many
// requests* the reader will actually make, without importing reader-core
// (reader-core pulls in the IndexedDB-backed store, which must never load just
// to draw a number). The batching rules below are therefore a frozen copy of
// reader-core's `translationBatches` + `splitTranslationBlocks`; the test suite
// pins the copy against the real implementation so drift fails loudly instead
// of turning the estimate into a lie.
//
// Everything here is pure: no DOM, no storage, no network, no provider format.
// Money is expressed as "per one million tokens" because that is how every
// provider prices, and the currency is whatever the caller's price table uses.

export const DEFAULT_PRICE = Object.freeze({ inputPerMillion: 0, outputPerMillion: 0 });

// reader-core's scheduling constants. Keep in sync with `translationBatches`
// (maxBlocks 24 / maxChars 3000) and its small leading batch (4 blocks /
// 600 chars) that gives the user a fast first paragraph.
const FIRST_BATCH_BLOCKS = 4;
const FIRST_BATCH_CHARS = 600;
const BATCH_BLOCKS = 24;
const BATCH_CHARS = 3_000;
// Short translation answers stay close to the source length; a 1.2 ratio keeps
// the estimate honest for languages that expand (Chinese -> English, German).
const OUTPUT_RATIO = 1.2;
// Every request also carries the translation system prompt plus the JSON
// envelope ({ "translations": [...] }). Leaving that out would understate a
// 30-request page translation by thousands of tokens.
const REQUEST_OVERHEAD_TOKENS = 250;

// CJK ideographs, kana, hangul and compatibility blocks: one token per
// character is the closest cheap approximation for these scripts.
const CJK = /[\u3005\u3007\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/u;
// Latin letters (ASCII plus Latin-1/Latin Extended-A) and digits pack roughly
// four characters into a token for BPE tokenizers.
const WORD = /[A-Za-z0-9\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f]/u;

// reader-core reads block text as `String(block?.text || '')`, so a falsy
// value (0, false, null) means "no text" rather than the string '0'. Matching
// that keeps the billable block count identical to the real run.
function blockText(block) {
  return String((block && block.text) || '');
}

function textOf(value) {
  if (typeof value === 'string') return value;
  return value === null || value === undefined ? '' : String(value);
}

// Fractional token count. Callers sum several fragments and round once, which
// avoids the "every fragment costs at least one token" inflation.
function rawTokens(text) {
  let cjk = 0;
  let word = 0;
  let other = 0;
  for (const char of textOf(text)) {
    if (CJK.test(char)) cjk += 1;
    else if (WORD.test(char)) word += 1;
    else other += 1;
  }
  return cjk + word / 4 + other / 3;
}

/** Estimate a token count: CJK 1 char/token, Latin+digits 4 chars/token, punctuation and whitespace 3 chars/token. Always at least 1. */
export function estimateTokens(text) {
  // An empty page still costs one token; returning 0 would let a UI divide by
  // zero or render "0 tokens" for a request that does spend money.
  return Math.max(1, Math.ceil(rawTokens(text)));
}

// Number() throws on symbols and throwing would break the "never throws"
// contract this module promises to the UI, so every coercion goes through here.
function numeric(value) {
  if (typeof value === 'symbol') return Number.NaN;
  try {
    return Number(value);
  } catch {
    return Number.NaN;
  }
}

function positiveInteger(value, fallback) {
  const number = numeric(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}

function ratio(value, fallback) {
  const number = numeric(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function translationSettings(options) {
  const source = options && typeof options === 'object' ? options : {};
  return {
    firstBatchBlocks: positiveInteger(source.firstBatchBlocks, FIRST_BATCH_BLOCKS),
    firstBatchChars: positiveInteger(source.firstBatchChars, FIRST_BATCH_CHARS),
    batchBlocks: positiveInteger(source.batchBlocks, BATCH_BLOCKS),
    batchChars: positiveInteger(source.batchChars, BATCH_CHARS),
    outputRatio: ratio(source.outputRatio, OUTPUT_RATIO),
    requestOverheadTokens: Math.floor(ratio(source.requestOverheadTokens, REQUEST_OVERHEAD_TOKENS)),
  };
}

// Mirror of reader-core's (non-exported) `translationSplit`: prefer ending a
// part on a sentence boundary, then on whitespace, then hard-cut without
// splitting a surrogate pair.
function translationSplit(text, start, end) {
  const minimumEnd = start + Math.floor((end - start) * 0.65);
  for (let index = end - 2; index >= minimumEnd; index -= 1) {
    if (/[.!?。！？；;]/u.test(text[index]) && /\s/u.test(text[index + 1] || '')) {
      let nextStart = index + 2;
      while (nextStart < text.length && /\s/u.test(text[nextStart])) nextStart += 1;
      return { chunkEnd: index + 1, nextStart };
    }
  }
  for (let index = end - 1; index >= minimumEnd; index -= 1) {
    if (/\s/u.test(text[index])) {
      let nextStart = index + 1;
      while (nextStart < text.length && /\s/u.test(text[nextStart])) nextStart += 1;
      return { chunkEnd: index, nextStart };
    }
  }
  let chunkEnd = end;
  if (chunkEnd < text.length && /[\uD800-\uDBFF]/u.test(text[chunkEnd - 1] || '') && /[\uDC00-\uDFFF]/u.test(text[chunkEnd] || '')) {
    chunkEnd -= 1;
  }
  return { chunkEnd, nextStart: chunkEnd };
}

// One paragraph longer than the 3000-char block limit is split into parts
// before batching, because that is what reader-core does (a single 9000-char
// paragraph becomes three requests, not one).
function splitBlockText(text, limit) {
  const parts = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + limit);
    const split = end < text.length ? translationSplit(text, start, end) : { chunkEnd: end, nextStart: end };
    const chunkEnd = Math.max(start + 1, split.chunkEnd);
    parts.push(text.slice(start, chunkEnd));
    const previousStart = start;
    start = split.nextStart;
    if (start <= chunkEnd && chunkEnd < end) start = chunkEnd;
    // Defensive: a pathological split must never loop forever on a NaN/0 span.
    if (start <= previousStart) start = chunkEnd;
  }
  return parts;
}

// Mirror of reader-core's `translationBatches`, including the "long page" gate:
// the small leading batch applies only to the first batch of a page that is
// already known to be long, so short pages stay at one request.
function planBatches(parts, settings) {
  const { firstBatchBlocks, firstBatchChars, batchBlocks, batchChars } = settings;
  const totalChars = parts.reduce((sum, part) => sum + part.text.length, 0);
  const longPage = parts.length > batchBlocks || totalChars > batchChars;
  const leadingBlocks = Math.min(firstBatchBlocks, batchBlocks);
  const leadingChars = Math.min(firstBatchChars, batchChars);
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const part of parts) {
    const leading = longPage && !batches.length;
    const blockLimit = leading ? leadingBlocks : batchBlocks;
    const charLimit = leading ? leadingChars : batchChars;
    if (batch.length && (batch.length >= blockLimit || chars + part.text.length > charLimit)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(part);
    chars += part.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function translatableBlocks(context) {
  const blocks = Array.isArray(context?.blocks) ? context.blocks : [];
  const translatable = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    // Code is copied verbatim by the reader, never sent to the model, so it
    // must not appear in the price either.
    if (block.kind === 'code') continue;
    const text = blockText(block);
    // reader-core drops empty blocks before batching; counting them would
    // inflate the request count.
    if (!text) continue;
    translatable.push({ id: block.id == null ? '' : String(block.id), text });
  }
  return translatable;
}

/**
 * Estimate a full-page translation.
 * @param {{ blocks?: Array<{ id?: string, text?: string, kind?: string }>, body?: string, targetLanguage?: string }} context
 * @param {{ firstBatchBlocks?: number, firstBatchChars?: number, batchBlocks?: number, batchChars?: number, outputRatio?: number, requestOverheadTokens?: number }} [options]
 * @returns {{ blocks: number, parts: number, chars: number, requests: number, inputTokens: number, outputTokens: number, tokens: number }}
 */
export function estimateTranslation(context, options = {}) {
  // Only blocks are billable: `body` and `targetLanguage` shape the prompt
  // context but are not sent as translation units, so they must not inflate
  // the request estimate.
  const settings = translationSettings(options);
  const blocks = translatableBlocks(context);
  const parts = [];
  let chars = 0;
  for (const block of blocks) {
    chars += block.text.length;
    for (const text of splitBlockText(block.text, settings.batchChars)) parts.push({ id: block.id, text });
  }
  const batches = planBatches(parts, settings);
  const textTokens = parts.reduce((sum, part) => sum + rawTokens(part.text), 0);
  const inputTokens = Math.ceil(textTokens + batches.length * settings.requestOverheadTokens);
  const outputTokens = Math.ceil(textTokens * settings.outputRatio);
  return {
    blocks: blocks.length,
    parts: parts.length,
    chars,
    requests: batches.length,
    inputTokens,
    outputTokens,
    tokens: inputTokens + outputTokens,
  };
}

function answerSettings(options) {
  const source = options && typeof options === 'object' ? options : {};
  return {
    // An answer is a short Markdown reply grounded in the page, not a
    // translation of it; roughly a third of the supplied context is a sane
    // default and callers can override it for chatty models.
    outputRatio: ratio(source.outputRatio, 0.35),
    requestOverheadTokens: Math.floor(ratio(source.requestOverheadTokens, REQUEST_OVERHEAD_TOKENS)),
    // Whole-page answers on very long pages switch to a chunked path in
    // reader-core; callers that know the page is over that line can cap the
    // context here and get a floor instead of a fantasy number.
    maxContextChars: positiveInteger(source.maxContextChars, 0),
  };
}

/**
 * Estimate one question-answer turn (or one explicit explain/translate action).
 * @param {{ blocks?: Array<{ id?: string, text?: string }>, body?: string, title?: string, targetLanguage?: string }} context
 * @param {string} question
 * @param {{ outputRatio?: number, requestOverheadTokens?: number, maxContextChars?: number }} [options]
 * @returns {{ blocks: number, chars: number, requests: number, contextTokens: number, questionTokens: number, inputTokens: number, outputTokens: number, tokens: number }}
 */
export function estimateAnswer(context, question, options = {}) {
  const settings = answerSettings(options);
  const source = context && typeof context === 'object' ? context : {};
  const blocks = Array.isArray(source.blocks) ? source.blocks.filter(block => block && blockText(block)) : [];
  const body = textOf(source.body);
  const blockSource = blocks.map(block => blockText(block)).join('\n');
  // The answer prompt prefers the page body and falls back to block text, so
  // the estimate must follow the same preference or it will count the page
  // twice on documents that ship both.
  const fullContext = body.trim() ? body : blockSource;
  const contextText = settings.maxContextChars > 0 ? fullContext.slice(0, settings.maxContextChars) : fullContext;
  const title = textOf(source.title).slice(0, 300);
  const questionText = textOf(question);
  const contextTokens = Math.ceil(rawTokens(contextText) + rawTokens(title));
  const questionTokens = Math.ceil(rawTokens(questionText));
  const inputTokens = Math.ceil(rawTokens(contextText) + rawTokens(title) + rawTokens(questionText) + settings.requestOverheadTokens);
  const outputTokens = Math.ceil((rawTokens(contextText) + rawTokens(questionText)) * settings.outputRatio);
  return {
    blocks: blocks.length,
    chars: contextText.length,
    requests: 1,
    contextTokens,
    questionTokens,
    inputTokens,
    outputTokens,
    tokens: inputTokens + outputTokens,
  };
}

function priceValue(value) {
  // A missing key means "this provider does not publish that price", not
  // "free": returning null keeps the UI from claiming a misleading $0.00.
  if (value === null || value === undefined || value === '') return null;
  const number = numeric(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function tokenValue(value) {
  const number = numeric(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Format a cost in the caller's currency.
 * Returns null when no usable price is known (both sides zero or a bad price),
 * otherwise a string with up to four decimals; amounts below 0.0001 collapse to
 * '<0.0001' so a real charge never renders as a free request.
 */
export function formatCost(tokens = {}, price = DEFAULT_PRICE) {
  // A destructured parameter throws on null; an optional estimate panel must
  // render "no price" instead of taking the side panel down with it.
  const usage = tokens && typeof tokens === 'object' ? tokens : {};
  const source = price && typeof price === 'object' ? price : DEFAULT_PRICE;
  const inputPrice = priceValue(source.inputPerMillion);
  const outputPrice = priceValue(source.outputPerMillion);
  // A negative price is a caller bug, not a discount: hide the estimate.
  if (inputPrice === null || outputPrice === null) return null;
  if (inputPrice === 0 && outputPrice === 0) return null;
  const total = (tokenValue(usage.inputTokens) * inputPrice + tokenValue(usage.outputTokens) * outputPrice) / 1_000_000;
  if (!Number.isFinite(total) || total < 0) return null;
  if (total === 0) return '0.0000';
  if (total < 0.0001) return '<0.0001';
  return total.toFixed(4);
}

/** Group thousands for display: 123456 -> '123,456'. Values under 1000 keep their own form. */
export function formatTokens(value) {
  const number = numeric(value);
  if (!Number.isFinite(number) || number <= 0) return '0';
  if (number < 1000) return String(number);
  if (number >= 1e21) return String(number);
  const [integer, fraction] = String(number).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}
