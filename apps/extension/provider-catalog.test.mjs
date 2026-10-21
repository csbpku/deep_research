import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PROVIDER_CATALOG, PROVIDER_GROUPS, PROVIDER_PRESETS, matchingProviders } from './provider-catalog.js';

test('provider presets distinguish cloud companies, local servers and custom protocols', () => {
  assert.equal(new Set(PROVIDER_CATALOG.map(item => item.id)).size, PROVIDER_CATALOG.length);
  assert.deepEqual(PROVIDER_GROUPS.map(item => item.id), ['cloud', 'local', 'custom']);
  for (const item of PROVIDER_CATALOG) {
    assert.ok(PROVIDER_GROUPS.some(group => group.id === item.group));
    assert.ok(['openai', 'anthropic'].includes(item.protocol));
    if (item.group === 'custom') assert.equal(item.baseUrl, '');
    else {
      const url = new URL(item.baseUrl);
      assert.equal(url.protocol, item.group === 'local' ? 'http:' : 'https:');
      assert.equal(url.search + url.hash + url.username + url.password, '');
    }
  }
});

test('search recognizes the product names people use and keeps local services separate', () => {
  for (const [query, id] of [['Claude', 'anthropic'], ['Kimi', 'moonshot'], ['通义千问', 'qwen'], ['SiliconFlow', 'siliconflow'], ['Grok', 'xai'], ['Local Proxy', 'local-proxy']]) {
    assert.ok(matchingProviders(query).some(item => item.id === id));
  }
  assert.deepEqual(matchingProviders('本机').map(item => item.group), ['local', 'local', 'local']);
  assert.deepEqual(matchingProviders('provider-that-does-not-exist'), []);
});

test('legacy provider IDs remain loadable and protocol selection remains explicit', () => {
  for (const id of ['openai', 'anthropic', 'minimax', 'deepseek', 'local-proxy', 'custom', 'custom-anthropic']) assert.ok(PROVIDER_PRESETS[id]);
  assert.equal(PROVIDER_PRESETS['custom-anthropic'].protocol, 'anthropic');
  assert.equal(PROVIDER_PRESETS['local-proxy'].baseUrl, 'http://127.0.0.1:8317/v1');
  assert.equal(PROVIDER_PRESETS['lm-studio'].baseUrl, 'http://127.0.0.1:1234/v1');
  assert.equal(PROVIDER_PRESETS.ollama.baseUrl, 'http://127.0.0.1:11434/v1');
});

test('every provider has a packaged SVG with no executable or external resource references', async () => {
  for (const filename of new Set(PROVIDER_CATALOG.map(item => item.icon))) {
    const svg = await readFile(new URL(`assets/providers/${filename}`, import.meta.url), 'utf8');
    assert.match(svg, /<svg\b/u, filename);
    assert.doesNotMatch(svg, /<(?:script|foreignObject)\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']https?:|url\(\s*["']?https?:/iu, filename);
  }
  assert.match(await readFile(new URL('assets/providers/LICENSE.txt', import.meta.url), 'utf8'), /MIT/u);
});
