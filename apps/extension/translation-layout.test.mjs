import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  TRANSLATION_LAYOUTS,
  TRANSLATION_LAYOUT_KEY,
  layoutForBlock,
  normalizeTranslationLayout,
  resolveTranslationLayout,
} from './translation-layout.js';

const contentSource = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('./reader-ui.css', import.meta.url), 'utf8');

/**
 * Slice a classic-script function (signature plus body) out of content.js.
 * Parameter destructuring contains braces, so the body brace is located after
 * the closing parenthesis, not with a plain indexOf('{').
 */
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `content.js must keep the mirrored ${name}()`);
  let index = source.indexOf('(', start);
  let parentheses = 0;
  for (; index < source.length; index += 1) {
    if (source[index] === '(') parentheses += 1;
    else if (source[index] === ')') {
      parentheses -= 1;
      if (parentheses === 0) break;
    }
  }
  const bodyStart = source.indexOf('{', index);
  assert.ok(bodyStart > index, `${name}() must have a body`);
  let depth = 0;
  for (let cursor = bodyStart; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1;
    else if (source[cursor] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, cursor + 1);
    }
  }
  assert.fail(`${name}() must be a balanced function`);
}

function mirrorFunctions() {
  const normalize = functionSource(contentSource, 'normalizeReaderTranslationLayout');
  const resolve = functionSource(contentSource, 'resolveReaderTranslationLayout');
  const layout = functionSource(contentSource, 'readerLayoutForBlock');
  return runInNewContext(`(() => {
    ${normalize}
    ${resolve}
    ${layout}
    return { normalizeReaderTranslationLayout, resolveReaderTranslationLayout, readerLayoutForBlock };
  })()`);
}

function cssBlock(source, label) {
  const startMarker = '/* reader-translation-layout:start */';
  const endMarker = '/* reader-translation-layout:end */';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, `${label} must carry the mirrored layout rule block`);
  return source.slice(start + startMarker.length, end);
}

function normalizeCss(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\s+/gu, '');
}

test('the storage key stays the one the settings surface writes', () => {
  assert.equal(TRANSLATION_LAYOUT_KEY, 'readerTranslationLayout');
  assert.ok(
    contentSource.includes(`const READER_TRANSLATION_LAYOUT_KEY = '${TRANSLATION_LAYOUT_KEY}';`),
    'content.js must read the same storage key',
  );
  assert.ok(contentSource.includes('changes[READER_TRANSLATION_LAYOUT_KEY]'), 'content.js must react to storage changes');
});

test('the supported layouts are replace and stacked, in that order', () => {
  assert.deepEqual([...TRANSLATION_LAYOUTS], ['replace', 'stacked']);
});

test('a missing or unknown preference keeps the existing replacement behavior', () => {
  for (const value of [undefined, null, '', 'auto', 'side-by-side', 'bilingual', 0, 1, true, {}, [], () => {}]) {
    assert.equal(normalizeTranslationLayout(value), 'replace', `value=${String(value)}`);
    assert.equal(resolveTranslationLayout(value), 'replace', `value=${String(value)}`);
  }
});

test('explicit layouts are accepted with surrounding whitespace and any case', () => {
  for (const value of ['replace', ' stacked ', 'STACKED', 'Stacked', '\tstacked\n']) {
    assert.equal(normalizeTranslationLayout(value), value.trim().toLowerCase());
  }
});

test('resolveTranslationLayout only normalizes the stored preference', () => {
  for (const value of ['replace', 'stacked', ' STACKED ', 'unknown', undefined, 42]) {
    assert.equal(resolveTranslationLayout(value), normalizeTranslationLayout(value));
  }
});

test('replace never stacks regardless of the block type', () => {
  for (const tagName of ['p', 'h2', 'li', 'blockquote', 'pre', 'code', 'td', 'th']) {
    assert.equal(layoutForBlock({ layout: 'replace', tagName }), 'replace');
    assert.equal(layoutForBlock({ layout: ' PRETEND ', tagName }), 'replace');
  }
  assert.equal(layoutForBlock(), 'replace');
  assert.equal(layoutForBlock({}), 'replace');
});

test('stacked keeps prose blocks bilingual', () => {
  for (const tagName of ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'figcaption', 'caption', 'dt', 'dd', 'div', 'section']) {
    assert.equal(layoutForBlock({ layout: 'stacked', tagName }), 'stacked', tagName);
  }
  assert.equal(layoutForBlock({ layout: 'STACKED', tagName: 'P' }), 'stacked');
  assert.equal(layoutForBlock({ layout: ' stacked ', tagName: 'Blockquote' }), 'stacked');
});

test('stacked degrades code blocks and table cells to replace', () => {
  for (const tagName of ['pre', 'code', 'td', 'th', 'PRE', 'Td']) {
    assert.equal(layoutForBlock({ layout: 'stacked', tagName }), 'replace', tagName);
  }
  assert.equal(layoutForBlock({ layout: 'stacked', tagName: 'div', isCode: true }), 'replace');
  assert.equal(layoutForBlock({ layout: 'stacked', tagName: 'div', isTable: true }), 'replace');
  // A table cell passes the same fallback even without a recognizable tag name.
  assert.equal(layoutForBlock({ layout: 'stacked', tagName: '', isTable: true }), 'replace');
});

// The content script is a classic script and cannot import this module. It
// carries mirrored decisions, and this test keeps the two from drifting.
test('the content-script mirrors match the shared implementation', () => {
  const mirror = mirrorFunctions();

  const values = ['replace', 'stacked', ' STACKED ', 'Stacked', 'replace ', '', 'unknown', 'auto', undefined, null, 1, {}, []];
  for (const value of values) {
    assert.equal(mirror.normalizeReaderTranslationLayout(value), normalizeTranslationLayout(value), `normalize ${String(value)}`);
    assert.equal(mirror.resolveReaderTranslationLayout(value), resolveTranslationLayout(value), `resolve ${String(value)}`);
  }

  const blocks = [];
  for (const layout of values) {
    for (const tagName of ['p', 'H2', 'li', 'blockquote', 'pre', 'code', 'td', 'th', 'div', '', undefined]) {
      blocks.push({ layout, tagName });
      blocks.push({ layout, tagName, isCode: true });
      blocks.push({ layout, tagName, isTable: true });
    }
  }
  for (const block of blocks) {
    assert.equal(
      mirror.readerLayoutForBlock(block),
      layoutForBlock(block),
      `layoutForBlock ${JSON.stringify(block)}`,
    );
  }
});

test('stacked rendering marks both nodes for CSS and tests', () => {
  const pair = functionSource(contentSource, 'layoutTranslationPair');
  assert.ok(
    pair.includes("setAttribute('data-deep-research-layout', 'stacked')"),
    'the stacked branch must tag the translation node',
  );
  assert.ok(
    pair.includes("setAttribute('data-deep-research-bilingual-source', 'true')"),
    'the stacked branch must tag the source node',
  );
  assert.ok(pair.includes('ensureTranslationLayoutStyles();'), 'the stacked branch must inject the divider stylesheet');
  // Regression guard: bilingual mode must not hide the source.
  assert.ok(
    !/original\.style\.display\s*=\s*'none'/u.test(pair.split('} else {')[0]),
    'the stacked branch must keep the source visible',
  );
});

test('restoring translations removes both bilingual marks and shows the source again', () => {
  const restore = functionSource(contentSource, 'restoreTranslations');
  for (const fragment of [
    "removeAttribute('data-deep-research-layout')",
    "removeAttribute('data-deep-research-bilingual-source')",
    'original.style.display',
    'node.remove()',
    'restoreImageTranslations()',
  ]) {
    assert.ok(restore.includes(fragment), `restoreTranslations must keep: ${fragment}`);
  }
});

test('the divider rule block is mirrored between reader-ui.css and content.js', () => {
  const css = cssBlock(cssSource, 'reader-ui.css');
  const styleStart = contentSource.indexOf('const READER_TRANSLATION_LAYOUT_CSS = `');
  assert.ok(styleStart >= 0, 'content.js must keep the injected style constant');
  const literalStart = contentSource.indexOf('`', styleStart + 'const READER_TRANSLATION_LAYOUT_CSS = '.length);
  const literalEnd = contentSource.indexOf('`', literalStart + 1);
  assert.ok(literalStart >= 0 && literalEnd > literalStart, 'the injected style constant must be a template literal');
  const mirrored = contentSource.slice(literalStart + 1, literalEnd);

  assert.equal(
    normalizeCss(mirrored),
    normalizeCss(css),
    'content.js must inject exactly the reader-ui.css bilingual block',
  );
});

test('the bilingual divider uses design tokens and no literal colors', () => {
  const css = cssBlock(cssSource, 'reader-ui.css');
  assert.ok(css.includes('[data-deep-research-bilingual-source="true"]'), 'the source marker must be part of the selector');
  assert.ok(css.includes('[data-deep-research-layout="stacked"]'), 'the translation marker must be part of the selector');
  assert.ok(css.includes('var(--reader-color-outline)'), 'the divider color must come from a token');
  assert.ok(css.includes('var(--reader-color-surface-container)'), 'the wash color must come from a token');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/iu, 'no literal hex colors');
  assert.doesNotMatch(css, /\brgba?\s*\(/iu, 'no literal rgb colors');
});
