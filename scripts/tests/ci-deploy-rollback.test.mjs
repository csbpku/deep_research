import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mock = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const command = path.basename(process.argv[1]), args = process.argv.slice(2);
const fail = process.env.FAIL_STAGE;
if (command === 'stat') { console.log(args[1] === '%u' ? process.getuid() : '600'); process.exit(0); }
if (command === 'docker') {
  const text = args.join(' '), fresh = process.env.WEB_IMAGE === 'web:new';
  fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({args, web:process.env.WEB_IMAGE, ai:process.env.AI_ENGINE_IMAGE,
    config:fs.readFileSync(path.join(process.env.DEPLOY_PATH,'infra/nginx.conf'),'utf8'),
    marker:fs.readFileSync(path.join(process.env.DEPLOY_PATH,'.deployed-image-tag'),'utf8')})+'\\n');
  if (args[0] === 'inspect') { console.log(text.includes('repair-repair') ? 'repair:old' : text.includes('ai-engine') ? 'ai:old' : 'web:old'); process.exit(0); }
  if (text.includes('ps --status running --services')) console.log('postgres');
  if (text.includes('pg_dump')) { if(fail==='backup')process.exit(1); console.log('SQL snapshot'); }
  if (text.includes('config --quiet') && fail==='config') process.exit(1);
  if (text.includes(' pull ') && fail==='pull') {
    if(args.at(-1)==='web'){const p=path.join(process.env.DEPLOY_PATH,'.env');fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('OTHER=preserve','OTHER=concurrent-edit'));}process.exit(1);
  }
  if (text.includes(' up ') && !text.includes('--pull never') && fail==='start' && fresh) process.exit(1);
  if (text.includes('docker-compose.radar-repair.yml') && fail==='worker' && process.env.AI_ENGINE_IMAGE==='ai:new') process.exit(1);
  process.exit(0);
}
if (command === 'curl') {
  if(args.includes('%{http_code}')) { console.log(fail==='isolation' ? '200' : '404'); process.exit(0); }
  process.exit(fail==='health' && process.env.WEB_IMAGE==='web:new' ? 1 : 0);
}
`;

function release(failure = '') {
  const dir = mkdtempSync(join(tmpdir(), 'ci-deploy-rollback-'));
  const bin = join(dir, 'bin'), live = join(dir, 'infra'), stage = join(dir, '.releases/candidate');
  for (const folder of [bin, live, stage]) mkdirSync(folder, { recursive: true });
  const files = readFileSync(join(repo, 'infra/deploy-files.txt'), 'utf8').trim().split('\n');
  for (const name of files) {
    writeFileSync(join(live, name), `old:${name}\n`);
    writeFileSync(join(stage, name), `new:${name}\n`);
  }
  writeFileSync(join(stage, 'introduced.conf'), 'new file');
  writeFileSync(join(stage, 'deploy-files.txt'), [...files, 'introduced.conf'].join('\n') + '\n');
  const oldEnv = 'WEB_IMAGE=web:old\nAI_ENGINE_IMAGE=ai:old\nREADING_EXTENSION_BETA_URL=https://old.example/archive.zip\nREADING_EXTENSION_BETA_VERSION=0.1.0\nREADING_EXTENSION_BETA_SHA256='+'a'.repeat(64)+'\nOTHER=preserve\n';
  writeFileSync(join(dir, '.env'), oldEnv, { mode: 0o600 });
  writeFileSync(join(dir, '.deployed-image-tag'), '1'.repeat(40)+'\n');
  writeFileSync(join(dir, '.radar-repair-enabled'), '');
  for (const name of ['docker', 'curl', 'stat']) { writeFileSync(join(bin, name), mock); chmodSync(join(bin, name), 0o755); }
  for (const name of ['sleep', 'chgrp']) { writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, name), 0o755); }
  writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nwhile [ "$1" != docker ]; do shift; done\nexec "$@"\n'); chmodSync(join(bin, 'timeout'), 0o755);
  const log = join(dir, 'commands.jsonl');
  const result = spawnSync('bash', [join(repo, 'infra/deploy-release.sh')], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_PATH: dir, CANDIDATE_INFRA: stage,
      IMAGE_TAG: '2'.repeat(40), WEB_IMAGE: 'web:new', AI_ENGINE_IMAGE: 'ai:new',
      READER_BETA_URL: 'https://new.example/archive.zip', READER_BETA_VERSION: '0.2.0', READER_BETA_SHA256: 'b'.repeat(64),
      MOCK_LOG: log, FAIL_STAGE: failure },
  });
  return { dir, files, oldEnv, result, commands: readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

test('successful release switches configuration and records success after the optional worker', () => {
  const r = release();
  assert.equal(r.result.status, 0, r.result.stderr + r.result.stdout);
  assert.equal(readFileSync(join(r.dir, '.deployed-image-tag'), 'utf8').trim(), '2'.repeat(40));
  assert.match(readFileSync(join(r.dir, '.env'), 'utf8'), /WEB_IMAGE=web:new/);
  assert.equal(readFileSync(join(r.dir, 'infra/nginx.conf'), 'utf8'), 'new:nginx.conf\n');
  const worker = r.commands.find(command => command.args.includes('infra/docker-compose.radar-repair.yml'));
  assert.equal(worker.marker.trim(), '1'.repeat(40));
  const backup = readdirSync(join(r.dir, '.releases')).find(name => name.startsWith('rollback-'));
  assert.equal(readFileSync(join(r.dir, '.releases', backup, 'infra/nginx.conf'), 'utf8'), 'old:nginx.conf\n');
});

for (const failure of ['config', 'backup', 'pull', 'start', 'health', 'isolation', 'worker']) {
  test(`${failure} failure restores live files, release environment, actual old images, and marker`, () => {
    const r = release(failure);
    assert.notEqual(r.result.status, 0, r.result.stdout);
    assert.equal(readFileSync(join(r.dir, '.deployed-image-tag'), 'utf8').trim(), '1'.repeat(40));
    for (const name of r.files) assert.equal(readFileSync(join(r.dir, 'infra', name), 'utf8'), `old:${name}\n`, name);
    assert.equal(existsSync(join(r.dir, 'infra/introduced.conf')), false);
    assert.equal(readFileSync(join(r.dir, '.env'), 'utf8'), failure === 'pull' ? r.oldEnv.replace('OTHER=preserve', 'OTHER=concurrent-edit') : r.oldEnv);
    const rollback = r.commands.find(command => command.args.includes('never'));
    assert.equal(rollback.web, 'web:old');
    assert.equal(rollback.ai, 'ai:old');
    assert.equal(rollback.config, 'old:nginx.conf\n');
    const worker = r.commands.find(command => command.args.includes('infra/docker-compose.radar-repair.yml') && command.ai === 'repair:old');
    assert.ok(worker, 'restore the optional worker actual image as well');
  });
}
