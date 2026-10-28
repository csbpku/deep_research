import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = 'a'.repeat(40);
const version = JSON.parse(readFileSync(join(repo, 'apps/extension/package.json'), 'utf8')).version;
const asset = `deep-research-reader-beta-${version}.zip`;
const ghMock = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(process.env.MOCK_STATE,'utf8'));
const value=flag=>args[args.indexOf(flag)+1];
if(args[0]==='run'&&args[1]==='list'){console.log(JSON.stringify(state.runs));process.exit(0);}
if(args[0]==='run'&&args[1]==='download'){
 const plan=state.plans[args[2]];if(!plan)process.exit(1);
 fs.writeFileSync(path.join(value('--dir'),'ci-change-plan.json'),JSON.stringify(plan));process.exit(0);
}
if(args[0]==='api'){
 if(state.http){console.error('gh: request failed (HTTP '+state.http+')');process.exit(1);}
 console.log(JSON.stringify({prerelease:true,draft:false,assets:[{name:state.asset}]}));process.exit(0);
}
if(args[0]==='release'&&args[1]==='download'){
 fs.copyFileSync(state.archive,path.join(value('--dir'),state.asset));process.exit(0);
}
if(args[0]==='release'&&args[1]==='create'){
 fs.appendFileSync(process.env.MOCK_WRITES,JSON.stringify(args)+'\\n');process.exit(0);
}
console.error('unexpected gh operation');process.exit(1);
`;

function context(state) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-release-cli-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/gh'), ghMock); chmodSync(join(dir, 'bin/gh'), 0o755);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ asset, ...state }));
  const output = join(dir, 'output'), writes = join(dir, 'writes');
  writeFileSync(output, ''); writeFileSync(writes, '');
  const event = join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ workflow_run: { id: 1, head_sha: sha, event: 'push', conclusion: 'success', head_branch: 'main', head_repository: { full_name: 'example/repository' } } }));
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: dir,
    GITHUB_REPOSITORY: 'example/repository', GITHUB_SHA: sha, SOURCE_SHA: sha, GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: join(dir, 'summary'), GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'workflow_run',
    MOCK_STATE: join(dir, 'state.json'), MOCK_WRITES: writes };
  return { dir, output, writes, event, env,
    run: (script, args = [], overrides = {}) => spawnSync(process.execPath, [join(repo, 'scripts', script), ...args], { encoding: 'utf8', env: { ...env, ...overrides } }) };
}

function archive(directory, content) {
  const folder = join(directory, content); mkdirSync(folder);
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ version, manifest_version: 3 }));
  writeFileSync(join(folder, 'shared-theme.js'), content);
  const zip = join(folder, asset);
  execFileSync('zip', ['-q', zip, 'manifest.json', 'shared-theme.js'], { cwd: folder });
  return zip;
}

test('manual deployment selects fully validated CI instead of a documentation skip', () => {
  const plans = { 1: { source_sha: sha, head: sha, event: 'push', scope: 'documentation' },
    2: { source_sha: sha, head: sha, event: 'workflow_dispatch', scope: 'deployable' } };
  const c = context({ plans, runs: [1, 2].map(id => ({ databaseId: id, event: plans[id].event, headSha: sha, headBranch: 'main' })) });
  const result = c.run('ci-release-plan.mjs', [], { GITHUB_EVENT_NAME: 'workflow_dispatch' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(c.output, 'utf8'), /deployable=true\nci_run_id=2/);
});

test('automatic deployment rejects an artifact identifying a different SHA', () => {
  const c = context({ plans: { 1: { source_sha: 'b'.repeat(40), head: sha, event: 'push', scope: 'deployable' } } });
  const result = c.run('ci-release-plan.mjs');
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(c.output, 'utf8'), '');
});

test('a PR completion event cannot authorize publication', () => {
  const c = context({ plans: {} });
  const payload = JSON.parse(readFileSync(c.event, 'utf8')); payload.workflow_run.event = 'pull_request';
  writeFileSync(c.event, JSON.stringify(payload));
  assert.notEqual(c.run('ci-release-plan.mjs').status, 0);
});

test('new Reader release publishes the verified artifact with the tested target SHA', () => {
  const c = context({ http: 404 });
  const zip = archive(c.dir, 'new');
  const output = join(c.dir, 'candidate');
  const verified = c.run('ci-reader-beta.mjs', ['verify', zip, output]);
  assert.equal(verified.status, 0, verified.stderr);
  const published = c.run('ci-reader-beta.mjs', ['publish', output]);
  assert.equal(published.status, 0, published.stderr);
  const args = JSON.parse(readFileSync(c.writes, 'utf8').trim());
  assert.equal(args[args.indexOf('--target') + 1], sha);
  assert.ok(args.includes('--prerelease'));
});

test('Reader shared-dependency changes fail verification at the existing version', () => {
  const c = context({});
  const old = archive(c.dir, 'old'), current = archive(c.dir, 'changed');
  writeFileSync(c.env.MOCK_STATE, JSON.stringify({ archive: old, asset }));
  const result = c.run('ci-reader-beta.mjs', ['verify', current, join(c.dir, 'candidate')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bump the extension version/);
  assert.equal(readFileSync(c.writes, 'utf8'), '');
});

test('GitHub access failure cannot be treated as permission to create a Reader version', () => {
  const c = context({ http: 403 });
  const result = c.run('ci-reader-beta.mjs', ['verify', archive(c.dir, 'new'), join(c.dir, 'candidate')]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(c.dir, 'candidate/candidate.json')), false);
  assert.equal(readFileSync(c.writes, 'utf8'), '');
});
