import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dark, darkOverrides, light } from '../scripts/css.mjs';

function luminance(hex) {
  return [1, 3, 5].map((offset, i) => {
    const x = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return (x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
  }).reduce((sum, x) => sum + x, 0);
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}
for (const [name, tokens] of [['light', light], ['dark', dark]]) {
  test(`${name}: normal text, metadata, primary and semantic labels meet 4.5:1`, () => {
    for (const fg of ['color-text', 'color-text-secondary', 'color-text-muted', 'color-primary']) {
      for (const bg of ['color-surface', 'color-surface-container', 'color-surface-raised']) {
        assert.ok(contrast(tokens[fg], tokens[bg]) >= 4.5, `${name}: ${fg} on ${bg}`);
      }
    }
    for (const [fg, bg] of [['color-on-primary', 'color-primary'], ['color-primary', 'color-primary-container'], ['color-danger', 'color-danger-container'], ['color-warning', 'color-warning-container'], ['color-success', 'color-success-container'], ['color-evidence', 'color-evidence-container'], ['color-background-context', 'color-background-container'], ['color-inference', 'color-inference-container'], ['color-limitations', 'color-limitations-container']]) {
      assert.ok(contrast(tokens[fg], tokens[bg]) >= 4.5, `${name}: ${fg} on ${bg}`);
    }
    for (const source of ['github', 'articles', 'community', 'research', 'shared']) {
      const fg = tokens[`color-source-${source}`];
      for (const bg of [tokens[`color-source-${source}-container`], tokens['color-surface'], tokens['color-surface-container']]) {
        assert.ok(contrast(fg, bg) >= 4.5, `${name}: source ${source} label on ${bg}`);
      }
    }
    for (const tier of ['deep-read', 'skim', 'noise']) {
      const fg = tokens[`color-tier-${tier}`];
      for (const bg of [tokens['color-surface'], tokens['color-surface-container'], tokens['color-surface-raised']]) {
        assert.ok(contrast(fg, bg) >= 4.5, `${name}: reading tier ${tier} label on ${bg}`);
      }
    }
    for (const tier of ['hot', 'warming', 'emerging']) {
      const fg = tokens[`color-topic-${tier}`];
      const bg = tokens[`color-topic-${tier}-container`];
      assert.ok(contrast(fg, bg) >= 4.5, `${name}: topic ${tier} label on its container`);
    }
    for (const tone of ['text-muted', 'inference', 'evidence', 'success', 'warning']) {
      assert.ok(contrast(tokens[`color-${tone}`], tokens['color-surface-container']) >= 4.5, `${name}: syntax ${tone} on code background`);
    }
  });
}
test('dark mode explicitly defines every color instead of inheriting light values', () => {
  for (const key of Object.keys(light).filter(key => key.startsWith('color-'))) assert.ok(key in darkOverrides, key);
});
test('Web and Reader generated styles match the shared source', () => {
  execFileSync(process.execPath, [new URL('../scripts/generate.mjs', import.meta.url).pathname, '--check']);
  execFileSync(process.execPath, [new URL('../../../apps/extension/scripts/generate-design-system.mjs', import.meta.url).pathname, '--check']);
});

test('evidence has a distinct semantic colour from primary actions in both themes', () => {
  for (const [name, tokens] of [['light', light], ['dark', dark]]) {
    assert.notEqual(tokens['color-evidence'], tokens['color-primary'], `${name}: sources must be distinguishable from actions`);
    assert.ok(contrast(tokens['color-evidence'], tokens['color-evidence-container']) >= 4.5, `${name}: evidence text contrast`);
  }
});
