import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dark, darkOverrides, light, hexToHsl, renderLegacyBridge } from '../scripts/css.mjs';

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
  });
}
test('dark mode explicitly defines every color instead of inheriting light values', () => {
  for (const key of Object.keys(light).filter(key => key.startsWith('color-'))) assert.ok(key in darkOverrides, key);
});
test('legacy conversion preserves valid HSL tuples and does not use hex in hsl()', () => {
  assert.equal(hexToHsl('#ffffff'), '0 0% 100%');
  assert.equal(hexToHsl('#000000'), '0 0% 0%');
  assert.equal(hexToHsl('#ff0000'), '0 100% 50%');
  assert.throws(() => hexToHsl('white'));
  assert.doesNotMatch(renderLegacyBridge(), /--(?:primary|background): #/);
});
test('legacy reading-tier classes are generated from the shared semantic tokens', () => {
  const bridge = renderLegacyBridge();
  for (const [legacy, token] of [
    ['tier-deep-read', 'color-tier-deep-read'],
    ['tier-collection', 'color-tier-deep-read'],
    ['tier-skim', 'color-tier-skim'],
    ['tier-noise', 'color-tier-noise'],
    ['score-track', 'color-tier-track'],
  ]) {
    assert.ok(bridge.includes(`--${legacy}: ${hexToHsl(light[token])};`), `light ${legacy}`);
    assert.ok(bridge.includes(`--${legacy}: ${hexToHsl(dark[token])};`), `dark ${legacy}`);
  }
});
test('Web and Reader generated styles match the shared source', () => {
  execFileSync(process.execPath, [new URL('../scripts/generate.mjs', import.meta.url).pathname, '--check']);
  execFileSync(process.execPath, [new URL('../../../apps/extension/scripts/generate-design-system.mjs', import.meta.url).pathname, '--check']);
});
