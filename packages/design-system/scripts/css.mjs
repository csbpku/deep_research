import { readFile } from 'node:fs/promises';

export const light = JSON.parse(await readFile(new URL('../src/tokens.json', import.meta.url), 'utf8'));
export const darkOverrides = JSON.parse(await readFile(new URL('../src/dark.json', import.meta.url), 'utf8'));
export const dark = { ...light, ...darkOverrides };

/** HSL tuple, not a hex string: Tailwind 3 opacity modifiers depend on this. */
export function hexToHsl(hex) {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected six-digit hex: ${hex}`);
  const [r, g, b] = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (delta) {
    s = delta / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    h = ((h * 60) + 360) % 360;
  }
  return `${+h.toFixed(3)} ${+(s * 100).toFixed(3)}% ${+(l * 100).toFixed(3)}%`;
}

export function renderTokenCss() {
  const declarations = source => Object.entries(source).map(([key, value]) => `  --dr-${key}: ${value};`).join('\n');
  return `/* Generated from packages/design-system/src; do not edit. */\n:root {\n${declarations(light)}\n}\n:root.dark {\n${declarations(darkOverrides)}\n}\n`;
}

const legacy = {
  background: 'color-surface-container', foreground: 'color-text', card: 'color-surface', 'card-foreground': 'color-text',
  primary: 'color-primary', 'primary-foreground': 'color-on-primary', secondary: 'color-surface-container', 'secondary-foreground': 'color-text',
  muted: 'color-surface-container', 'muted-foreground': 'color-text-muted', accent: 'color-primary-container', 'accent-foreground': 'color-primary',
  destructive: 'color-danger', 'destructive-foreground': 'color-surface', popover: 'color-surface-raised', 'popover-foreground': 'color-text',
  border: 'color-outline', input: 'color-outline-strong', ring: 'color-primary',
};
const legacySemantic = {
  'status-queued-bg': 'color-warning-container', 'status-queued-fg': 'color-warning', 'status-queued-border': 'color-warning',
  'status-running-bg': 'color-evidence-container', 'status-running-fg': 'color-evidence', 'status-running-border': 'color-evidence',
  'status-succeeded-bg': 'color-success-container', 'status-succeeded-fg': 'color-success', 'status-succeeded-border': 'color-success',
  'status-failed-bg': 'color-danger-container', 'status-failed-fg': 'color-danger', 'status-failed-border': 'color-danger',
  'status-cancelled-bg': 'color-surface-container', 'status-cancelled-fg': 'color-text-secondary', 'status-cancelled-border': 'color-outline-strong',
  'status-partial-bg': 'color-warning-container', 'status-partial-fg': 'color-warning', 'status-partial-border': 'color-warning',
  'radar-candidate-bg': 'color-warning-container', 'radar-candidate-fg': 'color-warning',
  'radar-published-bg': 'color-success-container', 'radar-published-fg': 'color-success',
  'radar-rejected-bg': 'color-danger-container', 'radar-rejected-fg': 'color-danger',
  'radar-archived-bg': 'color-surface-container', 'radar-archived-fg': 'color-text-secondary',
  'radar-pending-bg': 'color-warning-container', 'radar-pending-fg': 'color-warning',
  'tier-hot-fg': 'color-topic-hot', 'tier-hot-bg': 'color-topic-hot-container',
  'tier-warming-fg': 'color-topic-warming', 'tier-warming-bg': 'color-topic-warming-container',
  'tier-emerging-fg': 'color-topic-emerging', 'tier-emerging-bg': 'color-topic-emerging-container',
  warning: 'color-warning', 'warning-bg': 'color-warning-container', 'warning-border': 'color-warning', 'warning-fg': 'color-warning',
  'method-manual': 'color-text-secondary', 'method-ai': 'color-inference', 'method-file': 'color-evidence', 'method-import': 'color-success',
  'tier-deep-read': 'color-tier-deep-read',
  'tier-collection': 'color-tier-deep-read',
  'tier-skim': 'color-tier-skim',
  'tier-noise': 'color-tier-noise',
  'score-track': 'color-tier-track',
};
export function renderLegacyBridge() {
  const hslDeclarations = source => Object.entries({ ...legacy, ...legacySemantic })
    .map(([key, token]) => `  --${key}: ${hexToHsl(source[token])};`).join('\n');
  return `/* Generated Tailwind HSL compatibility aliases from shared tokens; remove with the last legacy utility consumer. */\n:root {\n${hslDeclarations(light)}\n}\n:root.dark {\n${hslDeclarations(dark)}\n}\n`;
}
