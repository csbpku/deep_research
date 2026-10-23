// Print the Linux system packages that Playwright needs for its chromium
// build.
//
// The list is read out of the installed `playwright-core` bundle, so it
// always matches the browser build that is actually going to run. Nothing
// here duplicates Playwright's own dependency table.
//
// `playwright install --with-deps chromium` installs exactly two lists:
// the `tools` entries and the `chromium` entries.
//
// The table is keyed by platform id, and the package names differ between
// Ubuntu releases. On Ubuntu 24.04 `ttf-unifont` is `fonts-unifont`,
// `ttf-ubuntu-font-family` is gone and `libasound2` is `libasound2t64`.
// Handing a 20.04 name to apt on a 24.04 runner fails with "no
// installation candidate", so the entry for the platform that actually
// runs has to be picked. The first Ubuntu entry in the table is the oldest
// one, so taking the first match installs the wrong names.
//
// The platform is resolved in this order:
//   1. PLAYWRIGHT_DEPS_PLATFORM, for tests and for unusual runners.
//   2. The distribution and architecture of the machine (Linux).
//   3. The runner image that the CI workflows pin.
//
// Usage:
//   node scripts/playwright-deps-packages.mjs
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

// The CI workflows pin this runner image. It is also the fallback when the
// running machine is not Linux and no override is set.
export const DEFAULT_PLATFORM = 'ubuntu24.04-x64';

export function locateBundle(repoRootDir = repoRoot) {
  const require = createRequire(join(repoRootDir, 'apps/web/package.json'));
  const testPackage = require.resolve('@playwright/test/package.json');
  const corePackage = createRequire(testPackage).resolve('playwright-core/package.json');
  const candidate = join(dirname(corePackage), 'lib', 'coreBundle.js');
  if (existsSync(candidate)) return candidate;
  throw new Error(`Could not locate playwright-core/lib/coreBundle.js at ${candidate}.`);
}

// Read the platform table out of the bundle. Every entry looks like
//   "ubuntu24.04-x64": { tools: [ ... ], chromium: [ ... ] }
// The blocks are found by matching braces, so a package list can never
// bleed into the next platform.
export function parsePlatforms(source) {
  const platforms = new Map();
  const keyPattern = /"(ubuntu[0-9.]+-(?:x64|arm64))":\s*\{/g;
  let match;
  while ((match = keyPattern.exec(source)) !== null) {
    const body = readBlock(source, keyPattern.lastIndex);
    const packages = new Set();
    for (const target of ['tools', 'chromium']) {
      const section = new RegExp(`\\b${target}:\\s*\\[([^\\]]*)\\]`).exec(body);
      if (!section) continue;
      for (const entry of section[1].matchAll(/"([^"]+)"/g)) {
        packages.add(entry[1]);
      }
    }
    if (packages.size > 0) platforms.set(match[1], [...packages]);
  }
  if (platforms.size === 0) {
    throw new Error('The Playwright dependency table has no Ubuntu entry.');
  }
  return platforms;
}

function readBlock(source, start) {
  let depth = 0;
  let inString = false;
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}

function versionOf(platform) {
  const match = /ubuntu([0-9.]+)-/.exec(platform);
  if (!match) return null;
  return match[1].split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// Pick the entry for the platform that actually runs. When the exact entry
// is missing, the closest older release of the same architecture is used;
// if that does not exist either, the closest release of any architecture.
export function choosePlatform(platforms, preferred) {
  if (platforms.has(preferred)) return preferred;

  const preferredVersion = versionOf(preferred) ?? [];
  const preferredArch = preferred.slice(preferred.lastIndexOf('-') + 1);
  const all = [...platforms.keys()];
  const sameArch = all.filter((key) => key.endsWith(`-${preferredArch}`));
  const pool = sameArch.length > 0 ? sameArch : all;

  const scored = pool
    .map((key) => ({ key, version: versionOf(key) }))
    .filter((entry) => entry.version !== null)
    .sort((left, right) => compareVersions(left.version, right.version));

  const older = scored.filter((entry) => compareVersions(entry.version, preferredVersion) <= 0);
  if (older.length > 0) return older[older.length - 1].key;
  if (scored.length > 0) return scored[0].key;
  return preferred;
}

export function readOsRelease(file = '/etc/os-release') {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const values = {};
  for (const line of source.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    values[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  if (values.ID !== 'ubuntu' || !values.VERSION_ID) return null;
  return values.VERSION_ID;
}

export function resolveTargetPlatform({
  env = process.env,
  osRelease = readOsRelease(),
  arch = process.arch,
} = {}) {
  if (env.PLAYWRIGHT_DEPS_PLATFORM) return env.PLAYWRIGHT_DEPS_PLATFORM;
  const architecture = arch === 'arm64' ? 'arm64' : 'x64';
  if (osRelease) return `ubuntu${osRelease}-${architecture}`;
  return DEFAULT_PLATFORM;
}

export function packagesForPlatform(platforms, preferred) {
  const platform = choosePlatform(platforms, preferred);
  return { platform, packages: platforms.get(platform) ?? [] };
}

function main() {
  const bundle = locateBundle();
  const platforms = parsePlatforms(readFileSync(bundle, 'utf8'));
  const preferred = resolveTargetPlatform();
  const { platform, packages } = packagesForPlatform(platforms, preferred);
  if (platform !== preferred) {
    console.error(`Using the Playwright dependencies of ${platform} for ${preferred}.`);
  }
  for (const name of packages) {
    console.log(name);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}
