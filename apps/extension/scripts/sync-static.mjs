import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import './render-privacy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(root, 'public');
await mkdir(publicDir, { recursive: true });
for (const file of ['content.js', 'callback.html', 'callback.js']) {
  await copyFile(resolve(root, file), resolve(publicDir, file));
}
await mkdir(resolve(publicDir, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await copyFile(resolve(root, 'assets/icons', `icon-${size}.png`), resolve(publicDir, 'icons', `icon-${size}.png`));
}
