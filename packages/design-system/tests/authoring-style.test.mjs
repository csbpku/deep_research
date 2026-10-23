import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function collect(dir, filter) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collect(path, filter));
    else if (filter(path)) out.push(path);
  }
  return out;
}

const relativeToRepo = path => relative(repoRoot, path);

/**
 * The shared token layer is the single source of truth for colour, spacing
 * and typography. These guards fail when a legacy palette or a hard-coded
 * colour reappears, so a migration cannot silently regress.
 */
test('web sources never reference the removed legacy --ink palette', async () => {
  const files = await collect(join(repoRoot, 'apps/web/src'), path => /\.(tsx|ts|css)$/.test(path));
  const offenders = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    // A test may legitimately assert that the removed palette stays removed.
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
    if (content.includes('--ink-')) offenders.push(relativeToRepo(file));
  }
  assert.deepEqual(offenders, [], `legacy --ink variables are still referenced: ${offenders.join(', ')}`);
});

test('web sources never hard-code a hex colour outside the brand sign-in marks', async () => {
  const files = await collect(join(repoRoot, 'apps/web/src'), path => /\.(tsx|ts)$/.test(path));
  const offenders = [];
  for (const file of files) {
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
    // The Google brand marks are the only licensed third-party colours.
    if (relativeToRepo(file) === 'apps/web/src/app/signin/page.tsx') continue;
    const content = await readFile(file, 'utf8');
    const match = content.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/);
    if (match) offenders.push(`${relativeToRepo(file)}: ${match[0]}`);
  }
  assert.deepEqual(offenders, [], `hard-coded colours found: ${offenders.join(', ')}`);
});

test('reader styles never hard-code a hex colour', async () => {
  const files = await collect(join(repoRoot, 'apps/extension'), path => {
    if (!/\.css$/.test(path)) return false;
    // Generated files mirror the shared token source and legitimately carry
    // the token values; only hand-written styles are under this rule.
    return !path.includes('/.output/')
      && !path.includes('/node_modules/')
      && !path.endsWith('/design-system/tokens.css');
  });
  const offenders = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const match = content.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/);
    if (match) offenders.push(`${relativeToRepo(file)}: ${match[0]}`);
  }
  assert.deepEqual(offenders, [], `hard-coded colours found: ${offenders.join(', ')}`);
});

test('reader content script uses shared tokens instead of literal rgba colours', async () => {
  const content = await readFile(join(repoRoot, 'apps/extension/content.js'), 'utf8');
  const literals = content.match(/rgba?\(\s*\d+/g) ?? [];
  assert.deepEqual(literals, [], `literal rgba colours found in content.js: ${literals.join(', ')}`);
});

test('the shared token files stay the single colour source for both runtimes', async () => {
  const tokens = JSON.parse(await readFile(join(repoRoot, 'packages/design-system/src/tokens.json'), 'utf8'));
  const dark = JSON.parse(await readFile(join(repoRoot, 'packages/design-system/src/dark.json'), 'utf8'));
  const webCss = await readFile(join(repoRoot, 'packages/design-system/generated/tokens.css'), 'utf8');
  const readerCss = await readFile(join(repoRoot, 'apps/extension/design-system/tokens.css'), 'utf8');

  for (const [key, value] of Object.entries(tokens)) {
    if (!key.startsWith('color-')) continue;
    assert.ok(webCss.includes(`--dr-${key}: ${value};`), `web css is missing ${key}`);
    assert.ok(readerCss.includes(`--reader-${key}: ${value};`), `reader css is missing ${key}`);
    assert.ok(key in dark, `dark scheme is missing ${key}`);
  }
});

test('the Reader renders one palette and never declares a second scheme', async () => {
  const readerCss = await readFile(join(repoRoot, 'apps/extension/design-system/tokens.css'), 'utf8');
  // A `.dark` block would be a second palette that only the extension knows
  // about, so the Reader must ship the shared light palette on its own.
  assert.ok(!/^\.dark\s*\{/mu.test(readerCss), 'the Reader stylesheet must not declare a dark palette');

  const offenders = [];
  for (const file of [
    'apps/extension/content.js',
    'apps/extension/sidepanel.js',
    'apps/extension/history.js',
    'apps/extension/entrypoints/sidepanel/main.tsx',
    'apps/extension/entrypoints/reading-history/main.tsx',
    'apps/extension/components/reader-theme.tsx',
    'apps/extension/components/material-runtime.tsx',
    'apps/extension/scripts/generate-design-system.mjs',
    'apps/extension/scripts/sync-static.mjs',
  ]) {
    const content = await readFile(join(repoRoot, file), 'utf8');
    if (/readerColorScheme|reader-color-scheme|useColorScheme|READER_DARK_DESIGN_TOKENS/u.test(content)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `the Reader must not reintroduce a colour scheme switch: ${offenders.join(', ')}`);
});

test('the Reader theme declares no colour schemes, so MUI never writes a scheme class', async () => {
  const theme = await readFile(join(repoRoot, 'apps/extension/components/reader-theme.tsx'), 'utf8');
  // With `colorSchemes`, MUI's provider writes `light`/`dark` onto <html>.
  // Two providers then fight over the class and the document ends up in a
  // palette the React state never selected.
  const code = theme.split('\n').filter(line => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).join('\n');
  assert.ok(!/\bcolorSchemes\b/u.test(code), 'the Reader theme must not declare colour schemes');
  assert.ok(!/\bcssVariables\b/u.test(code), 'the Reader theme must not enable MUI CSS theme variables');
});

test('Admin surfaces use MUI sx and no longer depend on the page-level Tailwind bridge', async () => {
  const files = [
    'apps/web/src/app/admin/AdminConsole.tsx',
    'apps/web/src/app/admin/AdminMaterial.tsx',
    'apps/web/src/app/admin/page.tsx',
    'apps/web/src/app/admin/radar/AdminRadarClient.tsx',
    'apps/web/src/app/admin/radar/page.tsx',
    'apps/web/src/app/admin/llm-usage/LlmUsageConsole.tsx',
    'apps/web/src/app/admin/llm-usage/page.tsx',
  ];
  const offenders = [];
  for (const file of files) {
    const content = await readFile(join(repoRoot, file), 'utf8');
    if (/\bclassName\s*=/u.test(content) || /admin\.module\.css/u.test(content)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `Admin pages still contain legacy style wiring: ${offenders.join(', ')}`);

  await assert.rejects(
    readFile(join(repoRoot, 'apps/web/src/app/admin/admin.module.css')),
    { code: 'ENOENT' },
    'the obsolete admin CSS bridge should be removed',
  );
});

test('Web authoring no longer includes the retired Tailwind compatibility pipeline', async () => {
  const webPackage = JSON.parse(await readFile(join(repoRoot, 'apps/web/package.json'), 'utf8'));
  const dependencies = { ...webPackage.dependencies, ...webPackage.devDependencies };
  for (const name of [
    '@radix-ui/react-dialog',
    '@radix-ui/react-slot',
    '@tailwindcss/typography',
    'class-variance-authority',
    'clsx',
    'tailwind-merge',
    'tailwindcss',
    'tailwindcss-animate',
  ]) {
    assert.ok(!(name in dependencies), `${name} should not be part of the Web styling stack`);
  }

  for (const path of [
    'apps/web/tailwind.config.ts',
    'apps/web/postcss.config.js',
    'apps/web/components.json',
    'apps/web/src/lib/utils.ts',
    'packages/design-system/generated/legacy-bridge.css',
  ]) {
    await assert.rejects(readFile(join(repoRoot, path)), { code: 'ENOENT' }, `${path} should be retired`);
  }

  const globals = await readFile(join(repoRoot, 'apps/web/src/app/globals.css'), 'utf8');
  assert.doesNotMatch(globals, /@tailwind\b|@apply\b|\.prose(?:\b|\.)/u);
  const layout = await readFile(join(repoRoot, 'apps/web/src/app/layout.tsx'), 'utf8');
  assert.doesNotMatch(layout, /legacy-bridge/u);
});

