import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gateJob = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8').split('  ci-gate:\n')[1];
const gateScript = gateJob.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
const successful = { CHANGES_RESULT: 'success', DOCS_ONLY: 'false', WEB_UNIT: 'success', WEB_E2E: 'success', WEB_MUI_E2E: 'success', PYTHON_E2E: 'success', READER_E2E: 'success' };
const gate = env => spawnSync('bash', ['-c', gateScript], { encoding: 'utf8', env: { ...process.env, ...successful, ...env } });

test('the actual workflow gate rejects a failed plan even when it emitted docs_only first', () => {
  assert.notEqual(gate({ CHANGES_RESULT: 'failure', DOCS_ONLY: 'true' }).status, 0);
});

test('the actual workflow gate accepts documentation skips and successful full validation', () => {
  assert.equal(gate({ DOCS_ONLY: 'true', WEB_UNIT: 'skipped', WEB_E2E: 'skipped', WEB_MUI_E2E: 'skipped', PYTHON_E2E: 'skipped', READER_E2E: 'skipped' }).status, 0);
  assert.equal(gate({}).status, 0);
});

test('the actual workflow gate rejects a skipped required Reader check for a code change', () => {
  assert.notEqual(gate({ READER_E2E: 'skipped' }).status, 0);
});

test('deployment archive uses the shared manifest and stages flat files including its runner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-deploy-archive-'));
  const archive = join(directory, 'deployment.tar.gz');
  const expected = readFileSync(join(repo, 'infra/deploy-files.txt'), 'utf8').trim().split('\n').sort();
  execFileSync('tar', ['-czf', archive, '-C', join(repo, 'infra'), '-T', join(repo, 'infra/deploy-files.txt')]);
  const actual = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(actual, expected);
  assert.ok(actual.includes('deploy-release.sh'));
  assert.ok(!actual.some(name => name.includes('.env')));
});
