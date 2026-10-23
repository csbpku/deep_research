import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const printer = resolve(repoRoot, 'scripts/playwright-deps-packages.mjs');
const installer = resolve(repoRoot, 'scripts/install-playwright-deps.sh');

/**
 * The package list is derived from the installed Playwright, so the tests
 * need the workspace dependencies. The change detection job runs without an
 * install, so the suite skips there and runs in the unit test job instead.
 */
const workspaceInstalled = (() => {
  try {
    const req = createRequire(resolve(repoRoot, 'apps/web/package.json'));
    req.resolve('@playwright/test/package.json');
    return true;
  } catch {
    return false;
  }
})();

const describe = workspaceInstalled ? test : test.skip;

function readPackages() {
  const output = execFileSync('node', [printer], { cwd: repoRoot, encoding: 'utf8' });
  return output.trim().split('\n').filter(Boolean);
}

describe('the package list is not empty and contains no duplicates', () => {
  const packages = readPackages();
  assert.ok(packages.length > 0, 'the dependency list must not be empty');
  assert.equal(new Set(packages).size, packages.length, 'the list must not repeat a package');
});

describe('the list covers the fonts that the E2E suites need for Chinese text', () => {
  // The CJK font is the reason the download is large, and the narrow-screen
  // tag regression failed with tofu boxes when it was missing.
  const packages = readPackages();
  assert.ok(packages.includes('fonts-wqy-zenhei'), 'the Chinese font must be installed');
});

describe('the list matches the Playwright dependency table in the installed package', async () => {
  // The list is read out of the installed Playwright, so it cannot drift.
  // This test only guards against the parser silently returning a subset.
  const packages = readPackages();
  const req = createRequire(resolve(repoRoot, 'apps/web/package.json'));
  const testPackage = req.resolve('@playwright/test/package.json');
  const corePackage = createRequire(testPackage).resolve('playwright-core/package.json');
  const bundle = readFileSync(resolve(dirname(corePackage), 'lib/coreBundle.js'), 'utf8');

  const platform = /"ubuntu[0-9.]*-(?:x64|arm64)":\s*\{/.exec(bundle);
  assert.ok(platform, 'the Playwright bundle must contain an Ubuntu dependency table');
  const body = bundle.slice(platform.index, platform.index + 20000);

  for (const target of ['tools', 'chromium']) {
    const section = new RegExp(`\\b${target}:\\s*\\[([^\\]]*)\\]`).exec(body);
    assert.ok(section, `the ${target} section must exist in the dependency table`);
    for (const entry of section[1].matchAll(/"([^"]+)"/g)) {
      assert.ok(packages.includes(entry[1]), `${entry[1]} from ${target} must be installed`);
    }
  }
});

describe('the installer script is executable and valid bash', () => {
  const source = readFileSync(installer, 'utf8');
  assert.ok(source.startsWith('#!/usr/bin/env bash'), 'the script needs a shebang');
  execFileSync('bash', ['-n', installer], { cwd: repoRoot });
});

describe('the installer reports the cache suffix for the current platform', () => {
  const output = execFileSync('bash', [installer, '--cache-suffix'], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(output.trim(), /^\S+-\d+\.\d+\.\d+$/, 'the suffix must contain the distro and the Playwright version');
});

describe('the installer prints the same packages as the package printer', () => {
  const fromInstaller = execFileSync('bash', [installer, '--print-packages'], { cwd: repoRoot, encoding: 'utf8' });
  assert.deepEqual(
    fromInstaller.trim().split('\n').filter(Boolean).sort(),
    readPackages().sort(),
  );
});
