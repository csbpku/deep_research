import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBraveHtml, relevantSources, parseSearchRss, safeSourceUrl, searchContext, standaloneSearch } from './web-search.js';

const xml = '<rss><channel><item><title>Docs &amp; Releases</title><link>https://example.org/releases</link><description>Latest &lt;b&gt;release&lt;/b&gt;</description></item><item><title>unsafe</title><link>javascript:alert(1)</link></item><item><link>https://example.org/releases</link></item></channel></rss>';
test('search excerpts reject unsafe URLs and duplicates; evidence labels stay separate', () => {
  const sources = parseSearchRss(xml);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].title, 'Docs & Releases');
  assert.equal(safeSourceUrl('https://token:secret@example.org'), '');
  assert.match(searchContext(sources), /\[W1\]/u);
  assert.match(searchContext(sources), /Never put external quotes in the original evidence array/u);
});
test('standalone sends only planned keywords to search, never provider authorization', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('brave.com')) return new Response('blocked', { status: 503 });
    return String(url).includes('bing.com') ? new Response(xml) : Response.json({ choices: [{ message: { content: '{"query":"library releases"}' } }] });
  });
  const result = await standaloneSearch({ baseUrl: 'https://model.test/v1', model: 'test', apiKey: 'private-model-key', protocol: 'openai' }, 'Is it maintained?', { title: 'Library', signal: new AbortController().signal });
  assert.equal(result.status, 'searched');
  assert.equal(requests.length, 3);
  assert.equal(new URL(requests[2].url).searchParams.get('q'), 'library releases');
  assert.equal(requests[2].options.credentials, 'omit');
  assert.equal(requests[2].options.headers, undefined);
  assert.ok(!requests[2].url.includes('private-model-key'));
});
test('planner skips web fetching for original-only questions', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ choices: [{ message: { content: '{"query":""}' } }] }); });
  assert.equal((await standaloneSearch({ baseUrl: 'https://model.test/v1', model: 'test', apiKey: 'test-key' }, 'Explain this sentence')).status, 'skipped');
  assert.equal(calls, 1);
});
test('sensitive planner output fails closed before a search request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ choices: [{ message: { content: '{"query":"sk-privatecredential123"}' } }] }); });
  await assert.rejects(standaloneSearch({ baseUrl: 'https://model.test/v1', model: 'test', apiKey: 'test-key' }, 'Check this'));
  assert.equal(calls, 1);
});

test('irrelevant search results are excluded instead of presented as evidence', () => {
  const html = '<div data-type="web"><a href="https://react.dev/"><div class="title snippet">React</div></a><div class="content snippet">Build component interfaces.</div></div>';
  assert.equal(parseBraveHtml(html)[0].title, 'React');
  assert.equal(relevantSources(parseBraveHtml(html), 'React official docs').length, 1);
  assert.equal(relevantSources([{title:'Official dictionary',url:'https://example.org',snippet:'Definition of official.'}], 'React official docs').length, 0);
});


test('full-page chunk synthesis retains the separate external context', async t => {
  const { explainSelection } = await import('./reader-core.js');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    const synthesis = request.messages[0].content.includes('只综合提供的全文分块分析');
    return Response.json({ choices: [{ message: { content: synthesis ? '{"answer":"Original context and external context [W1].","evidence":[],"limitations":[]}' : '{"findings":["Components compose UI"],"evidence":[],"uncertainties":[]}' }, finish_reason: 'stop' }] });
  });
  await explainSelection({ baseUrl: 'http://localhost:1234/v1', model: 'test' }, { title: 'React', url: 'https://article.test', scope: 'page', body: 'React builds interfaces from components. '.repeat(2000) }, 'Relate this to current docs.', [], { webContext: '[W1] React official documentation' });
  const final = requests.at(-1);
  assert.match(final.messages[0].content, /\[W1\] React official documentation/u);
  assert.ok(requests.length > 1);
});


test('follow-up context retains previous web URLs without implying a fresh search', async () => {
  const { readingHistoryText } = await import('./reader-core.js');
  const text = readingHistoryText({ content: 'See [W1].', webSources: [{ title: 'React docs', url: 'https://react.dev/learn' }] });
  assert.match(text, /https:\/\/react.dev\/learn/u);
  assert.match(text, /historical, untrusted context/u);
  assert.ok(text.length <= 8000);
  assert.equal(readingHistoryText({ content: 'x'.repeat(8000) }).length, 8000);
  assert.doesNotMatch(readingHistoryText({ webSources: [{url:'javascript:alert(1)'}] }), /javascript:/u);
});
