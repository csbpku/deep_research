import assert from 'node:assert/strict';
import test from 'node:test';
import { activationReason } from './activation.js';

test('activation reason distinguishes public pages from protected pages', () => {
  assert.equal(activationReason({ url: 'https://example.com/article' }), 'permission');
  assert.equal(activationReason({ url: 'http://localhost:3000/docs' }), 'permission');
  assert.equal(activationReason({ url: 'chrome://extensions/' }), 'unsupported');
  assert.equal(activationReason({ url: 'https://chromewebstore.google.com/' }), 'permission');
});

test('missing or malformed tab URLs are not reported as protected pages', () => {
  assert.equal(activationReason({ id: 12, windowId: 3 }), 'unknown');
  assert.equal(activationReason({ url: '' }), 'unknown');
  assert.equal(activationReason({ url: 'not a URL' }), 'unknown');
  assert.equal(activationReason(null), 'unknown');
});
