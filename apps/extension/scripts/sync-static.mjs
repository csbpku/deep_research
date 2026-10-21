import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import './render-privacy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(root, 'public');
await mkdir(publicDir, { recursive: true });
await import('./generate-design-system.mjs');
const tokens = JSON.parse(await readFile(new URL('../../../packages/design-system/src/tokens.json', import.meta.url), 'utf8'));
const contentSource = await readFile(resolve(root, 'content.js'), 'utf8');
const tokenPlaceholder = 'const READER_DESIGN_TOKENS = {};';
if (!contentSource.includes(tokenPlaceholder)) {
  throw new Error('content.js is missing the design token placeholder');
}
const english = JSON.parse(await readFile(resolve(root, 'locales/en.json'), 'utf8'));
await writeFile(resolve(publicDir, 'content.js'), contentSource.replace(tokenPlaceholder, `const READER_DESIGN_TOKENS = ${JSON.stringify(tokens)};`).replace('const READER_EN_MESSAGES = {};', `const READER_EN_MESSAGES = ${JSON.stringify(english)};`));
await copyFile(resolve(root, 'reader-platform-bridge.js'), resolve(publicDir, 'reader-platform-bridge.js'));
for (const locale of ['en', 'zh_CN']) {
  const localeDir = resolve(publicDir, '_locales', locale);
  await mkdir(localeDir, { recursive: true });
  const messages = await readFile(resolve(root, '_locales', locale, 'messages.json'), 'utf8');
  await writeFile(resolve(localeDir, 'messages.json'), messages);
}
for (const file of ['callback.html', 'callback.js']) {
  await copyFile(resolve(root, file), resolve(publicDir, file));
}
await mkdir(resolve(publicDir, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await copyFile(resolve(root, 'assets/icons', `icon-${size}.png`), resolve(publicDir, 'icons', `icon-${size}.png`));
}
await mkdir(resolve(publicDir, 'providers'), { recursive: true });
for (const file of await readdir(resolve(root, 'assets/providers'))) {
  if (file.endsWith('.svg') || file === 'LICENSE.txt') {
    await copyFile(resolve(root, 'assets/providers', file), resolve(publicDir, 'providers', file));
  }
}
