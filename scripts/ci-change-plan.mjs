import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const detector = fileURLToPath(new URL('./ci-changed-paths.sh', import.meta.url));
const shaPattern = /^[0-9a-f]{40}$/;

export function changePlan({ event, payload, sha, cwd = process.cwd() }) {
  if (!shaPattern.test(sha ?? '')) throw new Error('A full source SHA is required');
  const plan = { source_sha: sha, event, head: sha, base: null, scope: 'deployable' };
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    if (event === 'pull_request') {
      const base = payload.pull_request?.base?.sha;
      const head = payload.pull_request?.head?.sha;
      if (!shaPattern.test(base ?? '') || !shaPattern.test(head ?? '')) throw new Error('Missing PR comparison');
      plan.head = head;
      plan.base = git('merge-base', base, head);
    } else if (event === 'push') {
      // A push can contain several commits, including a documentation-only tip.
      const before = payload.before;
      if (!shaPattern.test(before ?? '') || /^0+$/.test(before)) throw new Error('No push baseline');
      plan.base = git('rev-parse', '--verify', `${before}^{commit}`);
    } else {
      throw new Error('Manual validation runs every suite');
    }
    plan.scope = execFileSync('bash', [detector, '--scope', plan.base, plan.head], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!['documentation', 'ci-only', 'deployable'].includes(plan.scope)) throw new Error('Unknown change scope');
  } catch (error) {
    plan.scope = 'deployable';
    plan.reason = error.message;
  }
  return plan;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plan = changePlan({
    event: process.env.GITHUB_EVENT_NAME,
    payload: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    sha: process.env.GITHUB_SHA,
  });
  writeFileSync(process.env.PLAN_PATH, `${JSON.stringify(plan, null, 2)}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${plan.scope === 'documentation'}\nscope=${plan.scope}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Validation plan for ${plan.source_sha}\n\nScope: **${plan.scope}**. Comparison: ${plan.base ?? 'full validation'} → ${plan.head}.\n`);
}
