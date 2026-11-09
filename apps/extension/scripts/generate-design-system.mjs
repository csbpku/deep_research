import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharedSource = new URL('../../../packages/design-system/src/', import.meta.url);
const lightTokens = JSON.parse(await readFile(new URL('tokens.json', sharedSource), 'utf8'));
const darkOverrides = JSON.parse(await readFile(new URL('dark.json', sharedSource), 'utf8'));

// A dark override without a light counterpart would add a variable that only
// one scheme defines, leaving the other scheme to fall back to whatever it
// inherited. Fail here instead of shipping half a palette.
const unknownDarkTokens = Object.keys(darkOverrides).filter((key) => !(key in lightTokens));
if (unknownDarkTokens.length) {
  throw new Error(`dark.json overrides tokens that tokens.json does not define: ${unknownDarkTokens.join(', ')}`);
}

const declarations = (source) => Object.entries(source)
  .map(([key, value]) => `  --reader-${key}: ${value};`)
  .join('\n');
// The shared package writes its dark overrides under `.dark`; the Reader uses
// the same shape with an attribute selector so no `light`/`dark` class ever
// lands on <html>. Only the overrides are repeated — every other variable keeps
// the light value that `:root` already declared.
const css = `/* Generated from packages/design-system/src/tokens.json and dark.json. Do not edit generated values. */
:root {
  color-scheme: light;
${declarations(lightTokens)}
}
:root[data-reader-scheme="dark"] {
  color-scheme: dark;
${declarations(darkOverrides)}
}
`;

const output = resolve(extensionRoot, 'design-system/tokens.css');
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== css) throw new Error('Reader tokens.css is stale; regenerate it from the shared tokens.');
} else {
  await writeFile(output, css);
}
