import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renderTokenCss, renderLegacyBridge } from './css.mjs';

const output = new URL('../generated/', import.meta.url);
if (!process.argv.includes('--check')) await mkdir(output, { recursive: true });
for (const [file, content] of [['tokens.css', renderTokenCss()], ['legacy-bridge.css', renderLegacyBridge()]]) {
  const path = new URL(file, output);
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== content) throw new Error(`Generated ${file} is stale`);
  } else await writeFile(path, content);
}
