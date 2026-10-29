import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validatePlan(plan, sha, { manual = false } = {}) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '') || plan.source_sha !== sha || plan.head !== sha) {
    throw new Error('CI plan does not identify the requested source commit');
  }
  if (!['push', 'workflow_dispatch'].includes(plan.event) || !['documentation', 'ci-only', 'deployable'].includes(plan.scope)) {
    throw new Error('Unsupported CI plan');
  }
  if (manual && plan.scope === 'documentation') throw new Error('Manual deployment needs full CI, not skipped documentation checks');
  return manual || plan.scope === 'deployable';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.SOURCE_SHA;
  const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let runs;
  if (manual) {
    runs = JSON.parse(gh('run', 'list', '--repo', repository, '--workflow', 'ci.yml', '--commit', sha,
      '--status', 'success', '--limit', '20', '--json', 'databaseId,event,headBranch,headSha'));
    runs = runs.filter(run => run.headBranch === 'main' && run.headSha === sha && ['push', 'workflow_dispatch'].includes(run.event));
  } else {
    const run = payload.workflow_run;
    if (run?.event !== 'push' || run.conclusion !== 'success' || run.head_branch !== 'main'
      || run.head_repository?.full_name !== repository || run.head_sha !== sha) {
      throw new Error('Deployment requires successful CI from this repository main branch');
    }
    runs = [{ databaseId: run.id }];
  }
  let selected;
  for (const run of runs) {
    const directory = mkdtempSync(join(process.env.RUNNER_TEMP, 'ci-release-plan-'));
    gh('run', 'download', String(run.databaseId), '--repo', repository, '--name', 'ci-change-plan', '--dir', directory);
    const plan = JSON.parse(readFileSync(join(directory, 'ci-change-plan.json'), 'utf8'));
    if (manual && plan.scope === 'documentation') continue;
    selected = { id: run.databaseId, deployable: validatePlan(plan, sha, { manual }), scope: plan.scope };
    break;
  }
  if (!selected) throw new Error('Run full CI for the exact main SHA before manually deploying');
  appendFileSync(process.env.GITHUB_OUTPUT, `deployable=${selected.deployable}\nci_run_id=${selected.id}\nsource_sha=${sha}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Release plan\n\nSource: ${sha}. CI run: ${selected.id}. Scope: **${selected.scope}**. Deploy: **${selected.deployable}**.\n`);
}
