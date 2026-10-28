import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changePlan } from '../ci-change-plan.mjs';
import { validatePlan } from '../ci-release-plan.mjs';

function history() {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-plan-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '-q');
  const commit = (file, content) => { writeFileSync(join(cwd, file), content); git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const base = commit('app.js', 'v1');
  const code = commit('app.js', 'v2');
  const head = commit('README.md', 'documentation');
  return { cwd, base, code, head };
}

test('a multi-commit push includes code preceding a documentation-only tip', () => {
  const h = history();
  assert.equal(changePlan({ ...h, sha: h.head, event: 'push', payload: { before: h.base } }).scope, 'deployable');
  assert.equal(changePlan({ ...h, sha: h.head, event: 'push', payload: { before: h.code } }).scope, 'documentation');
});

test('unknown push baselines and manual runs require full validation', () => {
  const h = history();
  for (const payload of [{}, { before: '0'.repeat(40) }, { before: 'f'.repeat(40) }]) {
    assert.equal(changePlan({ ...h, sha: h.head, event: 'push', payload }).scope, 'deployable');
  }
  assert.equal(changePlan({ ...h, sha: h.head, event: 'workflow_dispatch', payload: {} }).scope, 'deployable');
});

test('PR scope uses its merge base while the artifact identifies the tested merge SHA', () => {
  const h = history();
  const plan = changePlan({ ...h, sha: h.head, event: 'pull_request', payload: { pull_request: { base: { sha: h.code }, head: { sha: h.head } } } });
  assert.equal(plan.scope, 'documentation');
  assert.equal(plan.source_sha, h.head);
  assert.throws(() => validatePlan(plan, h.head), /Unsupported/);
});

test('release consumes the exact CI plan and preserves documentation and CI-only skips', () => {
  const sha = 'a'.repeat(40);
  for (const scope of ['documentation', 'ci-only', 'deployable']) {
    const plan = { source_sha: sha, head: sha, event: 'push', scope };
    assert.equal(validatePlan(plan, sha), scope === 'deployable');
    assert.throws(() => validatePlan(plan, 'b'.repeat(40)), /requested source/);
  }
});

test('manual deployment requires a fully validated commit', () => {
  const sha = 'a'.repeat(40);
  assert.throws(() => validatePlan({ source_sha: sha, head: sha, event: 'push', scope: 'documentation' }, sha, { manual: true }), /full CI/);
  assert.equal(validatePlan({ source_sha: sha, head: sha, event: 'workflow_dispatch', scope: 'deployable' }, sha, { manual: true }), true);
});
