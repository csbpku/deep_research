import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PRICE,
  estimateAnswer,
  estimateTokens,
  estimateTranslation,
  formatCost,
  formatTokens,
} from './cost-estimate.js';

// ---------------------------------------------------------------------------
// Frozen reference: reader-core's batching, copied verbatim (minus the store).
//
// cost-estimate.js must predict how many requests the reader will send, and it
// cannot import reader-core (reader-core loads the IndexedDB-backed store). The
// copy below is the contract, and the golden table underneath it was measured
// against the real `translationBatches` on 2026-11-09 with:
//
//   node -e "const m=await import('./reader-core.js'); ..."
//
// To re-measure after touching reader-core:
//   READER_PARITY=1 node --test cost-estimate.test.mjs
// ---------------------------------------------------------------------------

function referenceSplit(text, start, end) {
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

function referenceSplitBlocks(blocks, maxChars = 3_000) {
  const tasks = [];
  const limit = Math.max(1, Math.floor(maxChars));
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const text = String(block?.text || '');
    if (!text) continue;
    const parts = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(text.length, start + limit);
      const split = end < text.length ? referenceSplit(text, start, end) : { chunkEnd: end, nextStart: end };
      const chunkEnd = Math.max(start + 1, split.chunkEnd);
      parts.push(text.slice(start, chunkEnd));
      start = split.nextStart;
      if (start <= chunkEnd && chunkEnd < end) start = chunkEnd;
    }
    parts.forEach((part, partIndex) => tasks.push({ ...block, id: `${block.id}:part:${partIndex}`, text: part, partCount: parts.length }));
  }
  return tasks;
}

function referenceBatches(items, { maxBlocks = 24, maxChars = 3_000, text = item => item.text } = {}) {
  const longPage = items.length > maxBlocks || items.reduce((sum, item) => sum + text(item).length, 0) > maxChars;
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const item of items) {
    const leading = longPage && !batches.length;
    const blockLimit = leading ? Math.min(4, maxBlocks) : maxBlocks;
    const charLimit = leading ? Math.min(600, maxChars) : maxChars;
    if (batch.length && (batch.length >= blockLimit || chars + text(item).length > charLimit)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(item);
    chars += text(item).length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function referenceRequests(blocks) {
  // reader-core filters code blocks, then splits long paragraphs, then batches.
  const pending = referenceSplitBlocks(blocks.filter(block => block && block.kind !== 'code' && String(block?.text || '')));
  const batches = referenceBatches(pending, { text: item => item.text });
  return { requests: batches.length, parts: pending.length, batches };
}

const paragraph = (length) => 'Cache invalidation is hard, so this paragraph explains the trade-off in detail. '
  .repeat(Math.ceil(length / 78))
  .slice(0, length);

// Declared once so the golden table, the reference comparison and the opt-in
// real-module comparison all describe exactly the same pages.
const SAMPLES = {
  'single paragraph': [{ id: 'a', text: 'A short paragraph about caching strategies and their cost.' }],
  'five medium paragraphs': Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, text: `Paragraph ${i} `.padEnd(60, 'x') })),
  'thirty short paragraphs': Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, text: `Body ${i} `.padEnd(100, 'y') })),
  'forty paragraphs of 200 chars': Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, text: paragraph(200) })),
  'one 7000-char paragraph': [{ id: 'e', text: paragraph(7_000) }],
  'code blocks are skipped': [
    { id: 'f1', text: paragraph(120) },
    { id: 'f2', kind: 'code', text: 'const answer = 42;' },
    { id: 'f3', text: '' },
  ],
  'exactly 24 paragraphs (short-page edge)': Array.from({ length: 24 }, (_, i) => ({ id: `g${i}`, text: paragraph(120) })),
  '25 paragraphs of 130 chars': Array.from({ length: 25 }, (_, i) => ({ id: `h${i}`, text: paragraph(130) })),
  'cjk long page': [{ id: 'i', text: '这是一段中文技术说明，用来测试分段与批次估算是否正确。'.repeat(200) }],
};

// Measured against reader-core's translationBatches + splitTranslationBlocks.
const GOLDEN = [
  ['single paragraph', 1, 1, 58],
  ['five medium paragraphs', 1, 5, 300],
  ['thirty short paragraphs', 3, 30, 3_000],
  ['forty paragraphs of 200 chars', 4, 40, 8_000],
  ['one 7000-char paragraph', 3, 3, 7_000],
  ['code blocks are skipped', 1, 1, 120],
  ['exactly 24 paragraphs (short-page edge)', 1, 24, 2_880],
  ['25 paragraphs of 130 chars', 2, 25, 3_250],
  ['cjk long page', 2, 2, 5_400],
];

test('estimateTokens follows the CJK / latin / punctuation weighting', () => {
  assert.equal(estimateTokens('中文'), 2, 'one token per CJK character');
  assert.equal(estimateTokens('中文中文'), 4);
  assert.equal(estimateTokens('hello world'), 3, '10 letters = 2.5, one space = 0.33, rounded up');
  assert.equal(estimateTokens('a'.repeat(400)), 100, 'four latin characters per token');
  assert.equal(estimateTokens('，，，'), 1, 'three punctuation characters per token');
  assert.equal(estimateTokens('中文ab'), 3, '2 + 0.5 rounds up');
  assert.equal(estimateTokens(''), 1, 'empty text still costs a minimum token');
  assert.equal(estimateTokens(null), 1);
  assert.equal(estimateTokens(undefined), 1);
  assert.equal(estimateTokens(' '), 1);
  assert.ok(estimateTokens('中文') > estimateTokens('aa'), 'CJK is denser than latin');
});

test('estimateTranslation reproduces the reader batch counts (golden table)', () => {
  for (const [name, requests, parts, chars] of GOLDEN) {
    const estimate = estimateTranslation({ blocks: SAMPLES[name] });
    assert.equal(estimate.requests, requests, `${name}: requests`);
    assert.equal(estimate.parts, parts, `${name}: split parts`);
    assert.equal(estimate.chars, chars, `${name}: translated characters`);
  }
});

test('estimateTranslation agrees with the frozen reader-core batching copy', () => {
  for (const [name, blocks] of Object.entries(SAMPLES)) {
    const reference = referenceRequests(blocks);
    const estimate = estimateTranslation({ blocks });
    assert.equal(estimate.requests, reference.requests, `${name}: request count`);
    assert.equal(estimate.parts, reference.parts, `${name}: part count`);
  }
});

test('estimateTranslation keeps agreeing on randomized pages', () => {
  // Deterministic PRNG so a failure is reproducible without a seed file.
  let state = 12345;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 100; round += 1) {
    const blocks = Array.from({ length: 1 + Math.floor(random() * 40) }, (_, i) => ({
      id: `r${i}`,
      text: paragraph(1 + Math.floor(random() * 8_000)),
    }));
    const reference = referenceRequests(blocks);
    const estimate = estimateTranslation({ blocks });
    assert.equal(estimate.requests, reference.requests, `round ${round}: requests`);
    assert.equal(estimate.parts, reference.parts, `round ${round}: parts`);
  }
});

test('opt-in parity check against the real reader-core module', { skip: process.env.READER_PARITY ? false : 'set READER_PARITY=1 to compare against reader-core (imports the store)' }, async () => {
  // Off by default: importing reader-core pulls the extension store into the
  // test process. The golden table above is the always-on lock; this test is
  // the "prove it again" switch for whoever edits reader-core next.
  const { translationBatches, splitTranslationBlocks } = await import('./reader-core.js');
  for (const [name, blocks] of Object.entries(SAMPLES)) {
    const pending = splitTranslationBlocks(blocks.filter(block => block.kind !== 'code' && block.text));
    const real = translationBatches(pending, { text: item => item.text });
    const estimate = estimateTranslation({ blocks });
    assert.equal(estimate.requests, real.length, `${name}: requests`);
    assert.equal(estimate.parts, pending.length, `${name}: parts`);
  }
});

test('code blocks and empty blocks never reach the estimate', () => {
  const estimate = estimateTranslation({
    blocks: [
      { id: 'code', kind: 'code', text: 'x'.repeat(5_000) },
      { id: 'empty', text: '' },
      { id: 'null-text' },
      null,
      'not a block',
      { id: 'real', text: 'hello' },
    ],
  });
  assert.equal(estimate.blocks, 1);
  assert.equal(estimate.requests, 1);
  assert.equal(estimate.chars, 5);
  assert.deepEqual(referenceRequests(SAMPLES['code blocks are skipped']).requests, 1);
});

test('estimateTranslation prices the requests it predicts', () => {
  const single = estimateTranslation({ blocks: [{ id: 'a', text: 'a'.repeat(40) }] });
  assert.equal(single.requests, 1);
  assert.equal(single.inputTokens, 260, '10 text tokens + 250 request overhead');
  assert.equal(single.outputTokens, 12, '1.2x output ratio');
  assert.equal(single.tokens, 272);

  const noOverhead = estimateTranslation({ blocks: [{ id: 'a', text: 'a'.repeat(40) }] }, { requestOverheadTokens: 0, outputRatio: 0 });
  assert.equal(noOverhead.inputTokens, 10);
  assert.equal(noOverhead.outputTokens, 0);
  assert.equal(noOverhead.tokens, 10);

  // 4 x 1000 chars is a long page: the small leading batch, then one big one.
  const leading = estimateTranslation({ blocks: Array.from({ length: 4 }, (_, i) => ({ id: `${i}`, text: 'b'.repeat(1_000) })) }, { requestOverheadTokens: 100 });
  assert.equal(leading.requests, 2);
  assert.equal(leading.chars, 4_000);
  assert.equal(leading.inputTokens, Math.ceil(1_000 + 2 * 100), 'overhead is charged per request');
});

test('estimateTranslation degrades safely on missing or hostile input', () => {
  for (const context of [null, undefined, {}, { blocks: null }, { blocks: 'nope' }, { blocks: [{ text: 0 }] }]) {
    const estimate = estimateTranslation(context);
    assert.deepEqual(estimate, { blocks: 0, parts: 0, chars: 0, requests: 0, inputTokens: 0, outputTokens: 0, tokens: 0 });
  }
  const base = estimateTranslation({ blocks: [{ id: 'a', text: paragraph(7_000) }] });
  const hostile = estimateTranslation({ blocks: [{ id: 'a', text: paragraph(7_000) }] }, {
    firstBatchBlocks: -4,
    firstBatchChars: Number.NaN,
    batchBlocks: 'many',
    batchChars: 0,
    outputRatio: -1,
    requestOverheadTokens: Infinity,
  });
  assert.equal(hostile.requests, base.requests, 'bad options fall back to the product defaults');
  assert.deepEqual(hostile, base);
});

test('estimateAnswer charges the question on top of the context', () => {
  const context = { blocks: [{ id: 'a', text: 'a'.repeat(40) }], body: 'a'.repeat(40), title: '' };
  const withQuestion = estimateAnswer(context, 'why?');
  const withoutQuestion = estimateAnswer(context, '');
  assert.equal(withQuestion.requests, 1);
  assert.equal(withQuestion.questionTokens, 2, "'why?' = 2 expected tokens after rounding");
  assert.ok(withQuestion.inputTokens > withoutQuestion.inputTokens, 'the question is real input');
  assert.ok(withQuestion.tokens >= withQuestion.inputTokens + withQuestion.outputTokens - 1);

  // The answer prompt prefers the body; counting both would double the page.
  const bodyOnly = estimateAnswer({ body: 'a'.repeat(40), blocks: [{ id: 'a', text: 'b'.repeat(4_000) }] }, 'hi');
  assert.equal(bodyOnly.contextTokens, 10, 'block text is ignored when a body is present');
  assert.equal(bodyOnly.chars, 40);

  const capped = estimateAnswer({ body: 'a'.repeat(4_000) }, 'hi', { maxContextChars: 40 });
  assert.equal(capped.chars, 40);
  assert.equal(capped.contextTokens, 10);

  const empty = estimateAnswer(null, null);
  assert.equal(empty.contextTokens, 0);
  assert.equal(empty.questionTokens, 0);
  assert.equal(empty.inputTokens, 250, 'the system prompt is paid even with no page');
  assert.equal(empty.outputTokens, 0);

  const longerAnswer = estimateAnswer({ body: 'a'.repeat(4_000) }, 'hi', { outputRatio: 1 });
  const shorterAnswer = estimateAnswer({ body: 'a'.repeat(4_000) }, 'hi');
  assert.ok(longerAnswer.outputTokens > shorterAnswer.outputTokens);
});

test('formatCost returns null without a usable price', () => {
  assert.equal(formatCost({ inputTokens: 1_000, outputTokens: 500 }), null);
  assert.equal(formatCost({ inputTokens: 1_000, outputTokens: 500 }, DEFAULT_PRICE), null);
  assert.equal(formatCost({ inputTokens: 1_000 }, { inputPerMillion: 0, outputPerMillion: 0 }), null);
  assert.equal(formatCost({ inputTokens: 1_000 }, { inputPerMillion: -1, outputPerMillion: 2 }), null, 'negative price is a bug, not a discount');
  assert.equal(formatCost({ inputTokens: 1_000 }, { inputPerMillion: Number.NaN, outputPerMillion: 2 }), null);
  assert.equal(formatCost({ inputTokens: 1_000 }, { inputPerMillion: null, outputPerMillion: null }), null);
  assert.equal(formatCost(), null);
  assert.equal(formatCost(null, { inputPerMillion: 1, outputPerMillion: 1 }), '0.0000', 'a null estimate costs nothing, but must not throw');
  assert.equal(formatCost({ inputTokens: 1_000 }, null), null);
  assert.equal(formatCost({ inputTokens: 1_000 }, 'priced elsewhere'), null);
});

test('formatCost rounds to four decimals and keeps tiny charges visible', () => {
  assert.equal(formatCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, { inputPerMillion: 1, outputPerMillion: 2 }), '3.0000');
  assert.equal(formatCost({ inputTokens: 1_000_000 }, { inputPerMillion: 0.15, outputPerMillion: 0 }), '0.1500');
  assert.equal(formatCost({ inputTokens: 1_234 }, { inputPerMillion: 1.234567, outputPerMillion: 0 }), '0.0015');
  assert.equal(formatCost({ inputTokens: 1, outputTokens: 0 }, { inputPerMillion: 0.5, outputPerMillion: 0 }), '<0.0001');
  assert.equal(formatCost({ inputTokens: 0, outputTokens: 0 }, { inputPerMillion: 3, outputPerMillion: 3 }), '0.0000');
  assert.equal(formatCost({ inputTokens: '100', outputTokens: null }, { inputPerMillion: 10, outputPerMillion: 10 }), '0.0010');
  assert.equal(formatCost({ inputTokens: 1_000 }, { inputPerMillion: '1.5', outputPerMillion: '0' }), '0.0015', 'string prices are accepted');
  assert.equal(formatCost({ inputTokens: -5, outputTokens: 0 }, { inputPerMillion: 3, outputPerMillion: 3 }), '0.0000', 'negative tokens cannot become a credit');
});

test('formatTokens groups thousands and passes small values through', () => {
  assert.equal(formatTokens(123456), '123,456');
  assert.equal(formatTokens(1_000), '1,000');
  assert.equal(formatTokens(1_000_000), '1,000,000');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(999.5), '999.5');
  assert.equal(formatTokens(12.5), '12.5');
  assert.equal(formatTokens('1234'), '1,234');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(-3), '0');
  assert.equal(formatTokens(Number.NaN), '0');
  assert.equal(formatTokens(null), '0');
});
