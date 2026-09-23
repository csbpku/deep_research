import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_WEB_APP_URL,
  LEGACY_LOCAL_WEB_APP_URL,
  normalizePlatformOrigin,
  resolvePlatformOrigin,
} from './platform-config.js';

test('platform connection defaults to the public Deep Research site', () => {
  assert.equal(resolvePlatformOrigin(''), DEFAULT_WEB_APP_URL);
  assert.equal(resolvePlatformOrigin(LEGACY_LOCAL_WEB_APP_URL), DEFAULT_WEB_APP_URL);
  assert.equal(normalizePlatformOrigin('techradar.top'), DEFAULT_WEB_APP_URL);
  assert.equal(normalizePlatformOrigin('techradar.top/reading/connect'), DEFAULT_WEB_APP_URL);
  assert.equal(normalizePlatformOrigin('localhost:3000'), LEGACY_LOCAL_WEB_APP_URL);
});

test('a radar entry can provide the platform origin when no explicit host is configured', () => {
  assert.equal(resolvePlatformOrigin('', 'http://localhost:3000/radar/1'), 'http://localhost:3000');
  assert.equal(resolvePlatformOrigin(LEGACY_LOCAL_WEB_APP_URL, 'http://localhost:3000/radar/1'), 'http://localhost:3000');
});

test('explicit platform origins are normalized and preserved', () => {
  assert.equal(normalizePlatformOrigin('https://research.example.test/path'), 'https://research.example.test');
  assert.equal(resolvePlatformOrigin('https://research.example.test/path', 'http://localhost:3000'), 'https://research.example.test');
  assert.equal(normalizePlatformOrigin('https://user:secret@research.example.test'), '');
  assert.equal(normalizePlatformOrigin('ftp://research.example.test'), '');
});
