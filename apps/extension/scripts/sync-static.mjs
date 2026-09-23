import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(root, 'public');
await mkdir(publicDir, { recursive: true });
for (const file of ['content.js', 'callback.html', 'callback.js']) {
  await copyFile(resolve(root, file), resolve(publicDir, file));
}
