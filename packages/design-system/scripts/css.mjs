import { readFile } from 'node:fs/promises';

export const light = JSON.parse(await readFile(new URL('../src/tokens.json', import.meta.url), 'utf8'));
export const darkOverrides = JSON.parse(await readFile(new URL('../src/dark.json', import.meta.url), 'utf8'));
export const dark = { ...light, ...darkOverrides };

export function renderTokenCss() {
  const declarations = source => Object.entries(source).map(([key, value]) => `  --dr-${key}: ${value};`).join('\n');
  return `/* Generated from packages/design-system/src; do not edit. */\n:root {\n${declarations(light)}\n}\n:root.dark {\n${declarations(darkOverrides)}\n}\n`;
}
