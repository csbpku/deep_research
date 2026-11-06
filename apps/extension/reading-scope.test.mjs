import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

// Load the classic script exactly as the build ships it, then read its export.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'reading-scope.js'), 'utf8');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(source, sandbox);
const { selectReadingRoots } = sandbox.module.exports;

function documentFrom(html) {
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
}

const paragraph = (index, length = 120) => `<p>第 ${index} 段正文。${'内容很长的说明文字，'.repeat(Math.ceil(length / 12))}</p>`;
const label = (element) => (element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}${element.className ? `.${element.className}` : ''}`);

test('two <main> elements: the article in the second one is selected, the title region is merged', () => {
  // Shape of a VitePress docs page: a thin title <main>, then the real <main>.
  const doc = documentFrom(`
    <aside class="sidebar"><a href="/a">Intro</a><a href="/b">Guides</a><a href="/c">API</a></aside>
    <main class="vp-doc"><h1>AI Assistants</h1><p>Practical ways to use AI assistants.</p></main>
    <main class="main">
      <h2>Why it works</h2>${paragraph(1)}${paragraph(2)}${paragraph(3)}
      <h2>Choose by task</h2>${paragraph(4)}${paragraph(5)}
      <ul><li>First item with detail about tooling.</li><li>Second item with detail about tooling.</li></ul>
    </main>`);
  const scope = selectReadingRoots(doc);
  assert.equal(scope.mode, 'scoped');
  assert.deepEqual(Array.from(scope.roots, label), ['main.vp-doc', 'main.main']);
  assert.equal(scope.partial, false);
  assert.ok(scope.coverage >= 0.9, `coverage ${scope.coverage}`);
});

test('a single article keeps the single-root selection (regression: body text unchanged)', () => {
  const doc = documentFrom(`<header>Site</header><article><h1>Title</h1>${paragraph(1)}${paragraph(2)}</article><footer>Foot</footer>`);
  const scope = selectReadingRoots(doc);
  assert.deepEqual(Array.from(scope.roots, label), ['article']);
  assert.equal(scope.partial, false);
});

test('a documentation page whose article sits in a non-semantic wrapper inside <main>', () => {
  const doc = documentFrom(`
    <main>
      <nav><a href="/x">Side one</a><a href="/y">Side two</a></nav>
      <div class="theme-doc-markdown markdown"><h1>Guide</h1>${paragraph(1)}${paragraph(2)}</div>
    </main>`);
  const scope = selectReadingRoots(doc);
  assert.equal(scope.roots.length, 1);
  assert.match(scope.roots[0].textContent, /第 2 段正文/);
});

test('an article nested in <main> that carries nearly all prose is still the reading root', () => {
  // Historical behaviour: the first <article> was the root. A small share of
  // other text in the enclosing <main> must not widen the body.
  const doc = documentFrom(`<main><header><h1>Blog</h1></header><article>${paragraph(1)}${paragraph(2)}</article><div class="share">Share this</div></main>`);
  const scope = selectReadingRoots(doc);
  assert.deepEqual(Array.from(scope.roots, label), ['article']);
});

test('a div-only blog post with no semantic container falls back to the page body', () => {
  const doc = documentFrom(`<div class="post-body"><div>${paragraph(1)}</div><div>${paragraph(2)}</div></div>`);
  const scope = selectReadingRoots(doc);
  assert.equal(scope.mode, 'page');
  assert.equal(scope.roots[0].tagName, 'BODY');
});

test('a sidebar full of links never becomes the reading root', () => {
  const links = Array.from({ length: 40 }, (_, i) => `<li><a href="/p${i}">Navigation entry number ${i}</a></li>`).join('');
  const doc = documentFrom(`<aside><ul>${links}</ul></aside><article>${paragraph(1)}${paragraph(2)}</article>`);
  const scope = selectReadingRoots(doc);
  assert.deepEqual(Array.from(scope.roots, label), ['article']);
});

test('text outside every candidate container is reported as partial coverage', () => {
  // The article is small and the real body sits in a plain div that is not a candidate.
  const doc = documentFrom(`
    <main><h1>Overview</h1>${paragraph(1, 60)}</main>
    <div class="content">${paragraph(2)}${paragraph(3)}${paragraph(4)}${paragraph(5)}${paragraph(6)}${paragraph(7)}${paragraph(8)}${paragraph(9)}${paragraph(10)}${paragraph(11)}${paragraph(12)}${paragraph(13)}${paragraph(14)}${paragraph(15)}${paragraph(16)}${paragraph(17)}</div>`);
  const scope = selectReadingRoots(doc);
  assert.equal(scope.partial, true);
  assert.ok(scope.coverage < 0.6, `coverage ${scope.coverage}`);
  assert.ok(scope.totalChars - scope.coveredChars > 1500);
});

test('aria-hidden and form content does not count toward the article', () => {
  const doc = documentFrom(`
    <main><h1>Title</h1>${paragraph(1)}${paragraph(2)}
      <div aria-hidden="true">${paragraph(3, 2000)}</div>
      <form><p>${'密码与登录说明，'.repeat(200)}</p></form>
    </main>`);
  const scope = selectReadingRoots(doc);
  assert.deepEqual(Array.from(scope.roots, label), ['main']);
  assert.equal(scope.partial, false);
  assert.ok(scope.coveredChars < 1000, `covered ${scope.coveredChars}`);
});

test('a container injected after load is picked up by re-selection', () => {
  const doc = documentFrom(`<main class="vp-doc"><h1>AI Assistants</h1><p>Practical ways to use AI assistants.</p></main><div id="app"></div>`);
  const before = selectReadingRoots(doc);
  assert.deepEqual(Array.from(before.roots, label), ['main.vp-doc']);
  assert.equal(before.partial, false);

  const late = doc.createElement('main');
  late.className = 'main';
  late.innerHTML = `<h2>Late section</h2>${paragraph(1)}${paragraph(2)}${paragraph(3)}`;
  doc.getElementById('app').appendChild(late);
  const after = selectReadingRoots(doc);
  assert.deepEqual(Array.from(after.roots, label), ['main.vp-doc', 'main.main']);
});

test('an empty document returns the body without throwing', () => {
  const doc = documentFrom('');
  const scope = selectReadingRoots(doc);
  assert.equal(scope.mode, 'page');
  assert.equal(scope.coverage, 1);
});

test('translations never change the roots, source character totals, or coverage', () => {
  const doc = documentFrom(`<main id="primary"><h1>Guide</h1><p>${'Primary source. '.repeat(80)}</p></main><main id="secondary"><h2>Details</h2><p>${'Secondary source. '.repeat(15)}</p></main>`);
  const before = selectReadingRoots(doc);
  assert.deepEqual(Array.from(before.roots, label), ['#primary', '#secondary']);

  doc.querySelector('#primary p').setAttribute('style', 'display:none');
  const translation = doc.createElement('p');
  translation.setAttribute('data-deep-research-translation', 'true');
  translation.textContent = '译文内容。'.repeat(1000);
  doc.getElementById('primary').appendChild(translation);
  const after = selectReadingRoots(doc);
  assert.deepEqual(after, before, 'only source prose participates in selection and coverage');
});

test('Reader output cannot become a candidate or hide a partial-coverage warning', () => {
  const doc = documentFrom(`<article id="source">${paragraph(1, 200)}</article><div>${paragraph(2, 4000)}</div>`);
  const before = selectReadingRoots(doc);
  assert.equal(before.partial, true);
  const translated = doc.createElement('div');
  translated.className = 'markdown-body';
  translated.setAttribute('data-deep-research-translation', 'true');
  translated.innerHTML = `<h1>Translated heading</h1>${paragraph(3, 6000)}`;
  doc.getElementById('source').appendChild(translated);
  const imageUi = doc.createElement('main');
  imageUi.setAttribute('data-deep-research-design-host', 'true');
  imageUi.innerHTML = paragraph(4, 6000);
  doc.body.appendChild(imageUi);
  assert.deepEqual(selectReadingRoots(doc), before);
});
