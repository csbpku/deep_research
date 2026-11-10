import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  READER_COLOR_SCHEME_KEY,
  normalizeColorSchemePreference,
  resolveColorScheme,
  shouldFollowSystem,
} from './color-scheme.js';

test('the storage key stays the one the settings surface writes', () => {
  assert.equal(READER_COLOR_SCHEME_KEY, 'readerColorScheme');
});

test('an explicit light preference ignores a dark system', () => {
  assert.equal(resolveColorScheme('light', true), 'light');
  assert.equal(resolveColorScheme('light', false), 'light');
});

test('an explicit dark preference ignores a light system', () => {
  assert.equal(resolveColorScheme('dark', false), 'dark');
  assert.equal(resolveColorScheme('dark', true), 'dark');
});

test('system follows the operating-system preference', () => {
  assert.equal(resolveColorScheme('system', true), 'dark');
  assert.equal(resolveColorScheme('system', false), 'light');
});

test('missing and invalid preferences behave like system', () => {
  for (const preference of [undefined, null, '', 'auto', 'sepia', 1, {}, []]) {
    assert.equal(normalizeColorSchemePreference(preference), 'system');
    assert.equal(resolveColorScheme(preference, true), 'dark');
    assert.equal(resolveColorScheme(preference, false), 'light');
  }
});

test('case and surrounding whitespace are normalized', () => {
  assert.equal(resolveColorScheme(' DARK ', false), 'dark');
  assert.equal(resolveColorScheme('\tLight\n', true), 'light');
  assert.equal(resolveColorScheme(' System ', true), 'dark');
});

test('shouldFollowSystem only reports the system preference', () => {
  assert.equal(shouldFollowSystem('system'), true);
  assert.equal(shouldFollowSystem(' SYSTEM '), true);
  assert.equal(shouldFollowSystem('light'), false);
  assert.equal(shouldFollowSystem('dark'), false);
  // An unknown value is the system preference, so it follows the OS.
  assert.equal(shouldFollowSystem('auto'), true);
});

// The content script is a classic script and cannot import this module. It
// carries a mirrored resolver, and this test keeps the two from drifting.
test('the content-script mirror matches the shared resolver', () => {
  const source = readFileSync(new URL('./content.js', import.meta.url), 'utf8');
  const start = source.indexOf('function resolveReaderColorScheme(');
  assert.ok(start >= 0, 'content.js must keep the mirrored scheme resolver');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) { end = index + 1; break; }
    }
  }
  assert.ok(end > bodyStart, 'content.js resolver must be a balanced function');
  const mirror = runInNewContext(`(${source.slice(start, end)})`);

  for (const preference of ['light', 'dark', 'system', ' DARK ', 'Light', 'auto', '', undefined, null, 1]) {
    for (const systemPrefersDark of [true, false]) {
      assert.equal(
        mirror(preference, systemPrefersDark),
        resolveColorScheme(preference, systemPrefersDark),
        `preference=${String(preference)} systemPrefersDark=${systemPrefersDark}`,
      );
    }
  }
});
