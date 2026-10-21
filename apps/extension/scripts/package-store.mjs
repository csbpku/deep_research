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
assert.equal(manifest.default_locale, 'zh_CN', 'Store package must declare its default locale');
assert.equal(manifest.name, '__MSG_extensionName__', 'Store package name must be localized');
assert.equal(manifest.description, '__MSG_extensionDescription__', 'Store package description must be localized');
assert.equal(manifest.action?.default_title, '__MSG_actionOpenReader__', 'Store package toolbar title must be localized');
assert.deepEqual([...(manifest.host_permissions || [])].sort(), ['https://techradar.top/*', 'https://www.techradar.top/*'].sort(), 'Only the audited platform launch bridge may have fixed host access');
assert.deepEqual(manifest.content_scripts, [{ matches: ['https://techradar.top/*', 'https://www.techradar.top/*'], js: ['reader-platform-bridge.js'], run_at: 'document_start' }]);
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
for (const locale of ['en', 'zh_CN']) {
  const messagesPath = resolve(build, '_locales', locale, 'messages.json');
  const messages = JSON.parse(await readFile(messagesPath, 'utf8'));
  assert.ok(messages.extensionName?.message, `Missing localized extension name: ${locale}`);
  assert.ok(messages.extensionDescription?.message, `Missing localized extension description: ${locale}`);
  assert.ok(Array.from(messages.extensionDescription.message).length <= 132, `Localized description exceeds the Chrome Web Store limit: ${locale}`);
  assert.ok(messages.actionOpenReader?.message, `Missing localized toolbar title: ${locale}`);
}

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
  checks: { manifestV3: true, onlyPlatformBridgeRequiredHosts: true, bundledIcons: true, bundledPrivacy: true, localizedMetadata: true, betaKeyOmitted: true },
  externalState: 'Packaging does not inspect the developer account, Dashboard draft, production allowlist or publication status. See docs/chrome-web-store/README.md and dated PROJECT_STATUS evidence.',
  remaining: ['Update and verify English and Simplified Chinese listing details and screenshots in Dashboard', 'Verify privacy disclosures and reviewer access against the submitted package', 'Keep the item in Draft; do not submit for review or publish without separate user authorization'],
};
await writeFile(resolve(delivery, 'package-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
