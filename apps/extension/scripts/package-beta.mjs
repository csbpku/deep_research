import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const outputDir = resolve(root, '.output');
const manifest = JSON.parse(await readFile(resolve(outputDir, 'chrome-mv3', 'manifest.json'), 'utf8'));
const staging = resolve(outputDir, `deep-research-reader-beta-${manifest.version}`);
const archive = resolve(outputDir, `deep-research-reader-beta-${manifest.version}.zip`);

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(resolve(outputDir, 'chrome-mv3'), staging, { recursive: true });
for (const file of ['BETA_INSTALL.md', 'PRIVACY.md', 'COMPATIBILITY.md', 'BETA_CHECKLIST.md']) {
  await cp(resolve(root, file), resolve(staging, file));
}
await rm(archive, { force: true });
await run('zip', ['-qr', archive, '.'], { cwd: staging });
console.log(`Beta bundle: ${archive}`);
