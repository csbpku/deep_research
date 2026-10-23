import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const detector = resolve(repoRoot, 'scripts/ci-changed-paths.sh');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

/**
 * Build a throwaway repository whose HEAD history mirrors the real change
 * shapes the CI gate has to classify.
 */
function withRepo(files, run) {
  const dir = mkdtempSync(resolve(tmpdir(), 'ci-changed-paths-'));
  try {
    git(dir, ['init', '--initial-branch=main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    for (const [path, content] of files) {
      const target = resolve(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base']);
    const base = git(dir, ['rev-parse', 'HEAD']).trim();
    return run({ dir, base });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Classify a change and return the detector exit code. */
function classify(dir, base, changed) {
  for (const [path, content] of changed) {
    const target = resolve(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'change']);
  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  try {
    execFileSync(detector, [base, head], { cwd: dir, stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status;
  }
}

const BASE_FILES = [
  ['README.md', '# base\n'],
  ['docs/contracts/api.md', '# contract\n'],
  ['apps/web/src/app/page.tsx', 'export default function Page() { return null; }\n'],
  ['apps/extension/PRIVACY.md', '# privacy\n'],
  ['apps/extension/BETA_INSTALL.md', '# install\n'],
  ['apps/extension/COMPATIBILITY.md', '# compatibility\n'],
  ['apps/extension/BETA_CHECKLIST.md', '# checklist\n'],
];

test('a docs-only change is classified as documentation', () => {
  withRepo(BASE_FILES, ({ dir, base }) => {
    assert.equal(classify(dir, base, [['docs/contracts/api.md', '# contract v2\n']]), 0);
  });
});

test('a root Markdown change is classified as documentation', () => {
  withRepo(BASE_FILES, ({ dir, base }) => {
    assert.equal(classify(dir, base, [['README.md', '# base v2\n']]), 0);
  });
});

test('a source change is classified as deployable', () => {
  withRepo(BASE_FILES, ({ dir, base }) => {
    assert.equal(classify(dir, base, [['apps/web/src/app/page.tsx', 'export default function Page() { return 1; }\n']]), 1);
  });
});

test('Markdown copied into the Reader Beta bundle is treated as a deployable change', () => {
  for (const path of [
    'apps/extension/PRIVACY.md',
    'apps/extension/BETA_INSTALL.md',
    'apps/extension/COMPATIBILITY.md',
    'apps/extension/BETA_CHECKLIST.md',
  ]) {
    withRepo(BASE_FILES, ({ dir, base }) => {
      assert.equal(classify(dir, base, [[path, '# changed\n']]), 1, `${path} must trigger a release`);
    });
  }
});

test('a change that mixes documentation and source is deployable', () => {
  withRepo(BASE_FILES, ({ dir, base }) => {
    assert.equal(
      classify(dir, base, [
        ['README.md', '# base v2\n'],
        ['apps/web/src/app/page.tsx', 'export default function Page() { return 1; }\n'],
      ]),
      1,
    );
  });
});

test('renaming a source file into docs/ is still a deployable change', () => {
  withRepo(BASE_FILES, ({ dir, base }) => {
    git(dir, ['mv', 'apps/web/src/app/page.tsx', 'docs/archived-page.tsx']);
    git(dir, ['commit', '-m', 'rename']);
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    try {
      execFileSync(detector, [base, head], { cwd: dir, stdio: 'pipe' });
      assert.fail('expected the detector to report a deployable change');
    } catch (error) {
      assert.equal(error.status, 1);
    }
  });
});

test('an unknown base commit fails closed', () => {
  withRepo(BASE_FILES, ({ dir, base }) => {
    try {
      execFileSync(detector, ['0000000000000000000000000000000000000000', base], { cwd: dir, stdio: 'pipe' });
      assert.fail('expected the detector to reject an unknown base commit');
    } catch (error) {
      assert.equal(error.status, 2);
    }
  });
});

test('--list prints one changed path per line', () => {
  withRepo(BASE_FILES, ({ dir, base }) => {
    const head = classify(dir, base, [['docs/contracts/api.md', '# contract v2\n']]) === 0
      ? git(dir, ['rev-parse', 'HEAD']).trim()
      : null;
    const output = execFileSync(detector, ['--list', base, head], { cwd: dir, encoding: 'utf8' });
    assert.deepEqual(output.trim().split('\n'), ['docs/contracts/api.md']);
  });
});

test('the artefact Markdown list matches the Beta packaging script', () => {
  // The detector derives the list from the packaging script, so a newly
  // bundled Markdown file is classified as a deployable change without
  // touching the detector.
  const packageScript = resolve(repoRoot, 'apps/extension/scripts/package-beta.mjs');
  const source = readFileSync(packageScript, 'utf8');
  const bundled = [...source.matchAll(/'([^']+\.md)'/g)].map((match) => match[1]);
  assert.ok(bundled.length > 0, 'the packaging script must list at least one Markdown file');
  for (const name of bundled) {
    const path = `apps/extension/${name}`;
    withRepo(BASE_FILES, ({ dir, base }) => {
      assert.equal(classify(dir, base, [[path, '# changed\n']]), 1, `${path} must trigger a release`);
    });
  }
});
