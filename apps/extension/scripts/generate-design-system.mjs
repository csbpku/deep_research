import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(await readFile(new URL('../../../packages/design-system/src/tokens.json', import.meta.url), 'utf8'));
const aliases = {
  ink: 'color-text',
  'ink-soft': 'color-text-secondary',
  muted: 'color-text-muted',
  paper: 'color-surface',
  panel: 'color-surface-raised',
  faint: 'color-surface-container',
  'composer-fill': 'color-surface-composer',
  line: 'color-outline',
  accent: 'color-primary',
  'accent-soft': 'color-primary-container',
  amber: 'color-warning',
  'amber-soft': 'color-warning-container',
  danger: 'color-danger',
  success: 'color-success',
  'success-soft': 'color-success-container',
  'answer-size': 'type-reading',
  'answer-leading': 'line-height-reading',
  'evidence-ink': 'color-evidence',
  'evidence-fill': 'color-evidence-container',
  'background-ink': 'color-background-context',
  'background-fill': 'color-background-container',
  'inference-ink': 'color-inference',
  'inference-fill': 'color-inference-container',
  'limitations-ink': 'color-limitations',
  'limitations-fill': 'color-limitations-container',
  font: 'font-family',
  'shape-small': 'radius-small',
  'shape-medium': 'radius-medium',
  'shape-large': 'radius-large',
  'elevation-1': 'elevation-1',
};

const declarations = Object.entries(tokens)
  .map(([key, value]) => `  --reader-${key}: ${value};`)
  .join('\n');
const legacyAliases = Object.entries(aliases)
  .map(([alias, key]) => `  --${alias}: var(--reader-${key});`)
  .join('\n');
const css = `/* Generated from packages/design-system/src/tokens.json. Do not edit generated values. */
:root {
  color-scheme: light;
${declarations}

  /* Semantic aliases shared by Markdown and isolated webpage controls. */
${legacyAliases}
}
`;

const output = resolve(extensionRoot, 'design-system/tokens.css');
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== css) throw new Error('Reader tokens.css is stale; regenerate it from the shared tokens.');
} else {
  await writeFile(output, css);
}
