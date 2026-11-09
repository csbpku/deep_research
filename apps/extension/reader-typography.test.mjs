import test from 'node:test';
import assert from 'node:assert/strict';
import token from '@deep-research/design-system/tokens.json' with { type: 'json' };
import {
  READER_TYPE_SCALE_KEY,
  READER_TYPE_SCALES,
  normalizeTypeScale,
  typeScaleVariables,
} from './reader-typography.js';

test('the storage key stays the one the settings surface writes', () => {
  assert.equal(READER_TYPE_SCALE_KEY, 'readerTypeScale');
});

test('the scale ships exactly three steps in densest-to-openest order', () => {
  assert.deepEqual([...READER_TYPE_SCALES], ['compact', 'comfortable', 'large']);
  assert.ok(Object.isFrozen(READER_TYPE_SCALES));
  assert.throws(() => { READER_TYPE_SCALES.push('huge'); }, TypeError);
});

test('missing and invalid values fall back to the comfortable step', () => {
  for (const value of [undefined, null, '', '   ', 'huge', 'small', '15px', 15, true, {}, [], ['large']]) {
    assert.equal(normalizeTypeScale(value), 'comfortable');
  }
});

test('case and surrounding whitespace are normalized', () => {
  assert.equal(normalizeTypeScale(' LARGE '), 'large');
  assert.equal(normalizeTypeScale('Compact'), 'compact');
  assert.equal(normalizeTypeScale('\tcomfortable\n'), 'comfortable');
});

test('each step carries its own size, leading and heading gap', () => {
  assert.deepEqual(typeScaleVariables('compact'), {
    '--reader-reading-size': '14px',
    '--reader-reading-leading': '1.7',
    '--reader-markdown-heading-gap': '12px',
  });
  assert.deepEqual(typeScaleVariables('comfortable'), {
    '--reader-reading-size': '15px',
    '--reader-reading-leading': '1.8',
    '--reader-markdown-heading-gap': '16px',
  });
  assert.deepEqual(typeScaleVariables('large'), {
    '--reader-reading-size': '17px',
    '--reader-reading-leading': '1.9',
    '--reader-markdown-heading-gap': '24px',
  });
});

test('the default step matches the design-system tokens pixel for pixel', () => {
  const comfortable = typeScaleVariables('comfortable');
  assert.equal(comfortable['--reader-reading-size'], token['type-reading']);
  assert.equal(comfortable['--reader-reading-leading'], token['line-height-reading']);
  // The stylesheet halves this gap for the space below a heading, so matching
  // `space-4` is what keeps the 16px/8px heading rhythm the Reader had before
  // the scale existed.
  assert.equal(comfortable['--reader-markdown-heading-gap'], token['space-4']);
});

test('adjacent steps get larger in size and leading', () => {
  const steps = READER_TYPE_SCALES.map(scale => typeScaleVariables(scale));
  const numbers = steps.map(variables => Number.parseFloat(variables['--reader-reading-size']));
  const leadings = steps.map(variables => Number.parseFloat(variables['--reader-reading-leading']));
  const gaps = steps.map(variables => Number.parseFloat(variables['--reader-markdown-heading-gap']));
  for (const series of [numbers, leadings, gaps]) {
    assert.ok(series[0] < series[1] && series[1] < series[2], `expected ascending series, got ${series}`);
  }
});

test('only the three reading keys are published, all as CSS strings', () => {
  for (const scale of READER_TYPE_SCALES) {
    const variables = typeScaleVariables(scale);
    assert.deepEqual(Object.keys(variables).sort(), [
      '--reader-markdown-heading-gap',
      '--reader-reading-leading',
      '--reader-reading-size',
    ]);
    for (const value of Object.values(variables)) {
      assert.equal(typeof value, 'string');
      assert.match(value, /^\d+(\.\d+)?(px)?$/);
    }
  }
});

test('callers get a copy, so a mutated result cannot leak into the next read', () => {
  const first = typeScaleVariables('large');
  first['--reader-reading-size'] = '99px';
  assert.equal(typeScaleVariables('large')['--reader-reading-size'], '17px');
  assert.equal(typeScaleVariables('unexpected')['--reader-reading-size'], '15px');
});
