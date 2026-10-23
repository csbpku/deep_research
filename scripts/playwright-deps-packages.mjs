// Print the Linux system packages that Playwright needs for its chromium
// build.
//
// The list is read out of the installed `playwright-core` bundle, so it
// always matches the browser build that is actually going to run. Nothing
// here duplicates Playwright's own dependency table.
//
// `playwright install --with-deps chromium` installs exactly two lists:
// the `tools` entries and the `chromium` entries.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const require = createRequire(join(repoRoot, 'apps/web/package.json'));

function locateBundle() {
  const testPackage = require.resolve('@playwright/test/package.json');
  const corePackage = createRequire(testPackage).resolve('playwright-core/package.json');
  const candidate = join(dirname(corePackage), 'lib', 'coreBundle.js');
  if (existsSync(candidate)) return candidate;
  throw new Error(`Could not locate playwright-core/lib/coreBundle.js at ${candidate}.`);
}

function readPackages(source) {
  // The dependency table is keyed by platform id. Pick the Ubuntu entry
  // that matches the runner architecture.
  const platformPattern = /"ubuntu[0-9.]*-(x64|arm64)":\s*\{/g;
  let match;
  while ((match = platformPattern.exec(source)) !== null) {
    const body = source.slice(match.index, match.index + 20000);
    const packages = new Set();
    for (const target of ['tools', 'chromium']) {
      const section = new RegExp(`\\b${target}:\\s*\\[([^\\]]*)\\]`).exec(body);
      if (!section) continue;
      for (const entry of section[1].matchAll(/"([^"]+)"/g)) {
        packages.add(entry[1]);
      }
    }
    if (packages.size > 0) return [...packages];
  }
  throw new Error('The Playwright dependency table has no Ubuntu entry.');
}

const bundle = locateBundle();
const packages = readPackages(readFileSync(bundle, 'utf8'));
for (const name of packages) {
  console.log(name);
}
