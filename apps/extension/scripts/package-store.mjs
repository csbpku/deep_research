import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const build = resolve(root, '.output/chrome-mv3');
const manifest = JSON.parse(await readFile(resolve(build, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

assert.equal(manifest.manifest_version, 3, 'Store package must use Manifest V3');
assert.equal(manifest.version, pkg.version, 'Package and manifest versions must match');
assert.deepEqual(manifest.host_permissions || [], [], 'Refusing a build with required host access; rebuild without READER_E2E flags');
assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'alarms', 'contextMenus', 'scripting', 'sidePanel', 'storage', 'tabs', 'unlimitedStorage'].sort(), 'Review any new permission before packaging');
assert.deepEqual([...manifest.optional_host_permissions].sort(), ['http://*/*', 'https://*/*'].sort());
assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'");
assert.ok(!manifest.update_url, 'Updates must be managed by the Chrome Web Store');

for (const path of ['background.js', 'sidepanel.html', 'callback.html', 'privacy.html', ...Object.values(manifest.icons || {})]) {
  const absolute = resolve(build, path);
  assert.ok(!relative(build, absolute).startsWith('..'), `Invalid resource path: ${path}`);
  assert.ok((await stat(absolute)).isFile(), `Missing resource: ${path}`);
}
assert.ok(manifest.icons?.['128'], 'A 128px store icon is required');
for (const [size, file] of Object.entries(manifest.icons)) {
  const bytes = await readFile(resolve(build, file));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} must be PNG`);
  assert.equal(bytes.readUInt32BE(16), Number(size), `${file} width`);
  assert.equal(bytes.readUInt32BE(20), Number(size), `${file} height`);
}

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected symlink: ${path}`);
    assert.ok(!/^\.env(?:\.|$)|\.pem$|\.key$/u.test(entry.name), `Unexpected credential file: ${path}`);
    if (entry.isDirectory()) await inspect(path);
    else if (entry.name.endsWith('.html')) {
      const source = await readFile(path, 'utf8');
      assert.ok(!/<script\b[^>]*\bsrc\s*=\s*["']https?:/iu.test(source), `Remote executable script: ${path}`);
    }
  }
}
await inspect(build);

// Keep the Beta key and build intact. The Store assigns its own item ID/key;
// a unique staging folder also preserves every prior local upload artifact.
const outputRoot = resolve(root, '.output/store');
await mkdir(outputRoot, { recursive: true });
const delivery = await mkdtemp(resolve(outputRoot, `reader-${manifest.version}-`));
const staging = resolve(delivery, 'extension');
await cp(build, staging, { recursive: true });
delete manifest.key;
await writeFile(resolve(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const archive = resolve(delivery, `deep-research-reader-store-${manifest.version}.zip`);
await run('zip', ['-qr', archive, '.'], { cwd: staging });
const bytes = await readFile(archive);
const report = {
  version: manifest.version,
  archive,
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  checks: { manifestV3: true, noRequiredHostAccess: true, bundledIcons: true, bundledPrivacy: true, betaKeyOmitted: true },
  remaining: ['Register publisher account', 'Upload draft to obtain Store item ID', 'Allowlist Store ID for platform mode', 'Provide reviewer credentials', 'Submit and publish after review'],
};
await writeFile(resolve(delivery, 'package-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
