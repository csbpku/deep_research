import test from 'node:test';
import assert from 'node:assert/strict';
import { answerCoverage } from './answer-presentation.js';

const blocks = [
  { id: 'a', text: 'A bounded queue protects memory because work is admitted at a fixed rate.' },
  { id: 'b', text: 'The worker rejects stale work before it consumes model capacity.' },
  { id: 'c', text: 'Operators tune the queue per deployment.' },
];
const body = blocks.map((block) => block.text).join('\n\n');

test('coverage reports no evidence for an ungrounded answer', () => {
  const coverage = answerCoverage({ body, blocks, blockCount: 3 }, { evidence: [] });
  assert.deepEqual(coverage, {
    evidenceCount: 0,
    evidenceBlocks: 0,
    blockCount: 3,
    truncated: false,
    note: '本次回答没有可核对的原文证据',
  });
  assert.equal(answerCoverage({ body, blocks, blockCount: 3 }, {}).note, '本次回答没有可核对的原文证据');
});

test('coverage matches quotes to page blocks after whitespace normalisation', () => {
  const coverage = answerCoverage({ body, blocks, blockCount: 186 }, {
    evidence: [
      // The model usually reflows a quote; the block match must ignore that.
      { quote: 'A bounded queue protects\nmemory because work is admitted at a fixed rate.' },
      { quote: 'The worker rejects stale work before it consumes model capacity.' },
      { quote: '   ' },
      { quote: '' },
    ],
  });
  assert.equal(coverage.evidenceCount, 2, 'blank quotes are not evidence');
  assert.equal(coverage.evidenceBlocks, 2);
  assert.equal(coverage.blockCount, 186);
  assert.equal(coverage.truncated, false);
  assert.equal(coverage.note, '证据覆盖 2 段，正文共 186 段');
});

test('coverage counts a block once when two quotes come from the same paragraph', () => {
  const coverage = answerCoverage({ body, blocks, blockCount: blocks.length }, {
    evidence: [
      { quote: 'A bounded queue protects memory' },
      { quote: 'work is admitted at a fixed rate' },
    ],
  });
  assert.equal(coverage.evidenceCount, 2);
  assert.equal(coverage.evidenceBlocks, 1);
  assert.equal(coverage.note, '证据覆盖 1 段，正文共 3 段');
});

test('coverage states that a truncated page does not cover the whole article', () => {
  const expected = '证据覆盖 1 段；正文已按上限截取，结论未覆盖全文';
  const evidence = [{ quote: 'Operators tune the queue per deployment.' }];
  for (const context of [
    { body, blocks, blockCount: 3, bodyTruncated: true },
    { body, blocks, blockCount: 3, blocksTruncated: true },
    { body, blocks, blockCount: 3, coverageWarning: '本页超出当前处理上限' },
  ]) {
    const coverage = answerCoverage(context, { evidence });
    assert.equal(coverage.truncated, true);
    assert.equal(coverage.evidenceBlocks, 1);
    assert.equal(coverage.note, expected);
  }
  assert.equal(
    answerCoverage({ body, blocks, blockCount: 3, bodyTruncated: true }, { evidence: [] }).note,
    '本次回答没有可核对的原文证据；正文已按上限截取',
  );
});

test('coverage stays honest when the page has no block segmentation', () => {
  const coverage = answerCoverage({ body }, { evidence: [{ quote: 'rejects stale work' }] });
  assert.equal(coverage.blockCount, 0, 'zero means unknown, not "no paragraphs"');
  assert.equal(coverage.evidenceBlocks, 1);
  assert.equal(coverage.truncated, false);
  assert.equal(coverage.note, '证据覆盖 1 段，正文段数未知');

  const missing = answerCoverage({ body: 'Unrelated page text.' }, { evidence: [{ quote: 'rejects stale work' }] });
  assert.equal(missing.evidenceBlocks, 0);
  assert.equal(missing.note, '证据覆盖 0 段，正文段数未知');
  assert.equal(
    answerCoverage({ body: 'Unrelated page text.', blockCount: 12 }, { evidence: [{ quote: 'rejects stale work' }] }).note,
    '证据覆盖 0 段，正文共 12 段',
  );
});

test('coverage note goes through the injected translator', () => {
  const translate = (message, ...values) => (message === '证据覆盖 {0} 段，正文共 {1} 段'
    ? `${values[0]} of ${values[1]} source blocks cited`
    : format(message, values));
  assert.equal(
    answerCoverage({ body, blocks, blockCount: 3 }, { evidence: [{ quote: blocks[0].text }] }, { translate }).note,
    '1 of 3 source blocks cited',
  );
});

function format(message, values) {
  return message.replace(/\{(\d+)\}/gu, (_, index) => String(values[Number(index)] ?? ''));
}
