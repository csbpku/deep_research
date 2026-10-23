import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renderTokenCss } from './css.mjs';

const output = new URL('../generated/', import.meta.url);
if (!process.argv.includes('--check')) await mkdir(output, { recursive: true });
const path = new URL('tokens.css', output);
const content = renderTokenCss();
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== content) throw new Error('Generated tokens.css is stale');
} else await writeFile(path, content);
