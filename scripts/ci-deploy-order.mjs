import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function shouldDeploy(source, current, { manual = false, cwd = process.cwd() } = {}) {
  if (!/^[0-9a-f]{40}$/.test(source ?? '')) throw new Error('Invalid deployment SHA');
  if (!current) return true;
  if (!/^[0-9a-f]{40}$/.test(current)) throw new Error('Invalid deployed SHA');
  const git = (...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  git('cat-file', '-e', `${current}^{commit}`);
  if (source === current) return manual;
  const ancestor = (a, b) => {
    try { git('merge-base', '--is-ancestor', a, b); return true; }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  if (ancestor(source, current)) return false;
  if (!ancestor(current, source)) throw new Error('Deployment histories diverge; explicit recovery is required');
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const deploy = shouldDeploy(process.env.SOURCE_SHA, process.env.CURRENT_DEPLOYED_SHA, { manual: process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' });
  appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${deploy}\n`);
  if (!deploy) console.log('A newer or identical commit is already deployed; skipping this deployment');
}
