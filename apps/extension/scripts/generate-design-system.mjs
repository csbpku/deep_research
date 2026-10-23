import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(await readFile(new URL('../../../packages/design-system/src/tokens.json', import.meta.url), 'utf8'));

const declarations = Object.entries(tokens)
  .map(([key, value]) => `  --reader-${key}: ${value};`)
  .join('\n');
const css = `/* Generated from packages/design-system/src/tokens.json. Do not edit generated values. */
:root {
  color-scheme: light;
${declarations}
}
`;

const output = resolve(extensionRoot, 'design-system/tokens.css');
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== css) throw new Error('Reader tokens.css is stale; regenerate it from the shared tokens.');
} else {
  await writeFile(output, css);
}
