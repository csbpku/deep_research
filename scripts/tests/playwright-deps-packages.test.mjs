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

const {
  DEFAULT_PLATFORM,
  choosePlatform,
  parsePlatforms,
  resolveTargetPlatform,
} = await import(printer);

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

describe('the list matches the Playwright dependency table in the installed package', () => {
  // The list is read out of the installed Playwright, so it cannot drift.
  // This test only guards against the parser silently returning a subset.
  const packages = readPackages();
  const req = createRequire(resolve(repoRoot, 'apps/web/package.json'));
  const testPackage = req.resolve('@playwright/test/package.json');
  const corePackage = createRequire(testPackage).resolve('playwright-core/package.json');
  const bundle = readFileSync(resolve(dirname(corePackage), 'lib/coreBundle.js'), 'utf8');

  const platforms = parsePlatforms(bundle);
  const preferred = resolveTargetPlatform();
  const platform = choosePlatform(platforms, preferred);
  assert.ok(platform, 'the Playwright bundle must contain an Ubuntu dependency table');

  const expected = platforms.get(platform);
  assert.ok(expected.length > 0, 'the selected platform must have packages');
  for (const name of expected) {
    assert.ok(packages.includes(name), `${name} from ${platform} must be installed`);
  }
});

describe('the platform entry is the one that the runner actually uses', () => {
  // The table is ordered by release. Taking the first Ubuntu entry yields
  // the Ubuntu 20.04 package names, which do not exist on the 24.04
  // runner: `ttf-unifont` became `fonts-unifont`, `ttf-ubuntu-font-family`
  // was dropped and `libasound2` became the virtual `libasound2t64`.
  // The 2026-10-23 E2E run failed with "no installation candidate" for
  // exactly those three names.
  const platforms = new Map([
    [
      'ubuntu20.04-x64',
      ['xvfb', 'ttf-unifont', 'ttf-ubuntu-font-family', 'libasound2'],
    ],
    ['ubuntu22.04-x64', ['xvfb', 'fonts-unifont', 'libasound2']],
    ['ubuntu24.04-x64', ['xvfb', 'fonts-unifont', 'libasound2t64']],
  ]);

  assert.equal(choosePlatform(platforms, 'ubuntu24.04-x64'), 'ubuntu24.04-x64');
  assert.equal(choosePlatform(platforms, 'ubuntu22.04-x64'), 'ubuntu22.04-x64');
  // An unknown release falls back to the closest older one, so the names
  // still exist on the runner.
  assert.equal(choosePlatform(platforms, 'ubuntu26.04-x64'), 'ubuntu24.04-x64');
});

describe('the installed list contains no package that Ubuntu 24.04 dropped', () => {
  const packages = readPackages();
  const gone = ['ttf-unifont', 'ttf-ubuntu-font-family', 'libasound2'];
  for (const name of gone) {
    assert.ok(!packages.includes(name), `${name} does not exist on the runner`);
  }
  assert.ok(packages.includes('fonts-unifont'), 'the replacement font must be installed');
});

describe('the platform is resolved from the machine, with a pinned default', () => {
  assert.equal(
    resolveTargetPlatform({ env: { PLAYWRIGHT_DEPS_PLATFORM: 'ubuntu22.04-x64' }, osRelease: '24.04' }),
    'ubuntu22.04-x64',
    'the override wins',
  );
  assert.equal(
    resolveTargetPlatform({ env: {}, osRelease: '24.04', arch: 'x64' }),
    'ubuntu24.04-x64',
  );
  assert.equal(
    resolveTargetPlatform({ env: {}, osRelease: '24.04', arch: 'arm64' }),
    'ubuntu24.04-arm64',
  );
  assert.equal(
    resolveTargetPlatform({ env: {}, osRelease: null, arch: 'x64' }),
    DEFAULT_PLATFORM,
    'a machine without an Ubuntu release uses the pinned runner image',
  );
});

describe('the parser keeps the platform blocks apart', () => {
  // A package list must not bleed into the next platform block.
  const source = [
    'deps = {',
    '  "ubuntu20.04-x64": { tools: ["a"], chromium: ["b"] },',
    '  "ubuntu24.04-x64": { tools: ["c"], chromium: ["d"] },',
    '};',
  ].join('\n');
  const platforms = parsePlatforms(source);
  assert.deepEqual(platforms.get('ubuntu20.04-x64'), ['a', 'b']);
  assert.deepEqual(platforms.get('ubuntu24.04-x64'), ['c', 'd']);
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
