import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldDeploy } from '../ci-deploy-order.mjs';

test('a late older deployment cannot replace an already deployed descendant', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-order-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  writeFileSync(join(cwd, 'source'), 'one'); git('add', '.'); git('commit', '-qm', 'one');
  const one = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'source'), 'two'); git('commit', '-am', 'two');
  const two = git('rev-parse', 'HEAD');
  assert.equal(shouldDeploy(two, one, { cwd }), true);
  assert.equal(shouldDeploy(one, two, { cwd }), false);
  assert.equal(shouldDeploy(two, two, { cwd }), false);
  assert.equal(shouldDeploy(two, two, { cwd, manual: true }), true);
  assert.equal(shouldDeploy(two, '', { cwd }), true);
  assert.throws(() => shouldDeploy(two, 'not-a-sha', { cwd }), /Invalid deployed SHA/);
});
