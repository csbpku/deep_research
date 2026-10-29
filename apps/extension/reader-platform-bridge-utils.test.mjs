import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { getTrustedReaderPlatformOrigin, validateRadarSourceUrl } from './reader-platform-bridge-utils.js';

test('accepts only the configured platform origins', () => {
  assert.equal(getTrustedReaderPlatformOrigin({ origin: 'https://techradar.top', url: 'https://techradar.top/radar' }), 'https://techradar.top');
  assert.equal(getTrustedReaderPlatformOrigin({ origin: 'http://localhost:3000', url: 'http://localhost:3000/radar' }), 'http://localhost:3000');
  assert.equal(getTrustedReaderPlatformOrigin({ origin: 'https://evil.example', url: 'https://evil.example/' }), null);
  assert.equal(getTrustedReaderPlatformOrigin({ origin: 'null', url: 'file:///tmp/page.html' }), null);
});

test('accepts a radar article URL bound to the trusted platform origin', () => {
  const value = new URL('https://example.com/article?lang=en');
  value.searchParams.set('deep-research-source', 'radar');
  value.searchParams.set('deep-research-summary', 'summary-1');
  value.searchParams.set('deep-research-platform', 'https://techradar.top');
  value.hash = 'architecture';

  assert.equal(validateRadarSourceUrl(value.toString(), 'https://techradar.top'), value.toString());
});

test('rejects untrusted, malformed, credentialed, and non-radar targets', () => {
  assert.equal(validateRadarSourceUrl('javascript:alert(1)', 'https://techradar.top'), null);
  assert.equal(validateRadarSourceUrl('https://user:pass@example.com/article', 'https://techradar.top'), null);
  assert.equal(validateRadarSourceUrl('https://example.com/article?deep-research-source=radar', 'https://techradar.top'), null);
  assert.equal(validateRadarSourceUrl('https://example.com/article?deep-research-source=radar&deep-research-summary=1&deep-research-platform=https%3A%2F%2Fevil.example', 'https://techradar.top'), null);
});

test('an invalidated extension does not suppress the install link', () => {
  let listener;
  class Element {
    closest() { return this; }
    getAttribute() { return 'https://example.com/article?deep-research-source=radar&deep-research-summary=1'; }
  }
  const sandbox = {
    Element, URL,
    location: { origin: 'https://techradar.top', assign: () => assert.fail('must leave navigation to the link') },
    document: { addEventListener: (_type, callback) => { listener = callback; } },
    chrome: { runtime: { sendMessage: () => { throw new Error('Extension context invalidated'); } } },
  };
  vm.runInNewContext(readFileSync(new URL('./reader-platform-bridge.js', import.meta.url), 'utf8'), sandbox);
  let prevented = false;
  listener({ isTrusted: true, target: new Element(), preventDefault: () => { prevented = true; },
    stopPropagation: () => assert.fail('must not stop propagation'),
    stopImmediatePropagation: () => assert.fail('must not stop propagation') });
  assert.equal(prevented, false);
});
