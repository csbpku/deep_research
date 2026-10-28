import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectArchive, requireSameRelease } from '../ci-reader-beta.mjs';

function archive({ source = 'theme v1', compressed = true, version = '0.2.31' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reader-release-test-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version, manifest_version: 3 }));
  writeFileSync(join(dir, 'shared-theme.js'), source);
  const path = join(dir, 'reader.zip');
  execFileSync('zip', [compressed ? '-q9' : '-q0', path, 'manifest.json', 'shared-theme.js'], { cwd: dir });
  return path;
}

test('archive identity includes actual shared dependency output', () => {
  const original = inspectArchive(archive());
  const changed = inspectArchive(archive({ source: 'theme v2' }));
  assert.throws(() => requireSameRelease(changed, original), /bump the extension version/);
});

test('compression and ZIP metadata do not require a version bump', () => {
  const original = inspectArchive(archive());
  const repackaged = inspectArchive(archive({ compressed: false }));
  assert.notEqual(original.sha256, repackaged.sha256);
  assert.equal(original.fingerprint, repackaged.fingerprint);
  assert.doesNotThrow(() => requireSameRelease(repackaged, original));
});

test('invalid manifests fail before publication', () => {
  assert.throws(() => inspectArchive(archive({ version: 'not-a-version' })), /Invalid Reader version/);
});
