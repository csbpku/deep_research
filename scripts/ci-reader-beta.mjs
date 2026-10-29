import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (file, args, encoding = 'utf8') => execFileSync(file, args, {
  encoding, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

// ZIP timestamps and compression may differ even when the shipped files do not.
// Compare the complete built file tree so shared packages and resolved runtime
// dependencies participate without forcing a bump for unrelated lockfile edits.
export function inspectArchive(path) {
  run('unzip', ['-tq', path]);
  const names = run('unzip', ['-Z1', path]).trim().split('\n').filter(name => !name.endsWith('/')).sort();
  if (new Set(names).size !== names.length || names.some(name => name.startsWith('/') || /[?*\[]/.test(name) || name.split('/').includes('..'))) {
    throw new Error('Unsafe or duplicate archive entries');
  }
  const hash = createHash('sha256');
  for (const name of names) {
    const data = run('unzip', ['-p', path, name], null);
    hash.update(`${name}\0${data.length}\0`);
    hash.update(data);
  }
  const manifest = JSON.parse(run('unzip', ['-p', path, 'manifest.json']));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version ?? '')) throw new Error('Invalid Reader version');
  return {
    version: manifest.version,
    fingerprint: hash.digest('hex'),
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

export function requireSameRelease(candidate, existing) {
  if (candidate.version !== existing.version || candidate.fingerprint !== existing.fingerprint) {
    throw new Error('Reader build differs from the published version; bump the extension version');
  }
}

function existingRelease(version, directory) {
  const repository = process.env.GITHUB_REPOSITORY;
  const tag = `reader-v${version}`;
  let release;
  try {
    release = JSON.parse(run('gh', ['api', `repos/${repository}/releases/tags/${tag}`]));
  } catch (error) {
    // Only an explicit missing release authorizes creating a new version.
    // Authentication and transport errors must not masquerade as a new tag.
    if (/\(HTTP 404\)/.test(String(error.stderr))) return null;
    throw error;
  }
  if (!release.prerelease || release.draft) throw new Error('Existing Reader release must be a published pre-release');
  const asset = `deep-research-reader-beta-${version}.zip`;
  if (!release.assets.some(item => item.name === asset)) throw new Error('Existing Reader archive is missing');
  run('gh', ['release', 'download', tag, '--repo', repository, '--pattern', asset, '--dir', directory]);
  return inspectArchive(join(directory, asset));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, input, output] = process.argv.slice(2);
  if (!['verify', 'publish'].includes(mode) || !process.env.GITHUB_REPOSITORY) throw new Error('Expected verify|publish and repository context');
  if (mode === 'verify') {
    const info = inspectArchive(input);
    const packageVersion = JSON.parse(readFileSync(join(root, 'apps/extension/package.json'), 'utf8')).version;
    const manifestVersion = JSON.parse(readFileSync(join(root, 'apps/extension/manifest.json'), 'utf8')).version;
    if (info.version !== packageVersion || info.version !== manifestVersion) throw new Error('Reader versions differ');
    const previous = existingRelease(info.version, mkdtempSync(join(process.env.RUNNER_TEMP, 'reader-existing-')));
    if (previous) requireSameRelease(info, previous);
    mkdirSync(output, { recursive: true });
    const asset = `deep-research-reader-beta-${info.version}.zip`;
    copyFileSync(input, join(output, asset));
    writeFileSync(join(output, 'candidate.json'), `${JSON.stringify({ ...info, asset, source_sha: process.env.GITHUB_SHA }, null, 2)}\n`);
  } else {
    const metadata = JSON.parse(readFileSync(join(input, 'candidate.json'), 'utf8'));
    if (!/^[0-9a-f]{40}$/.test(process.env.SOURCE_SHA ?? '') || metadata.source_sha !== process.env.SOURCE_SHA
      || metadata.asset !== basename(metadata.asset)) throw new Error('Reader artifact does not identify the tested source');
    const archive = join(input, metadata.asset);
    const candidate = inspectArchive(archive);
    if (metadata.asset !== `deep-research-reader-beta-${candidate.version}.zip`
      || metadata.sha256 !== candidate.sha256 || metadata.fingerprint !== candidate.fingerprint) throw new Error('Reader artifact integrity check failed');
    const previous = existingRelease(candidate.version, mkdtempSync(join(process.env.RUNNER_TEMP, 'reader-existing-')));
    let sha256 = candidate.sha256;
    if (previous) {
      requireSameRelease(candidate, previous);
      sha256 = previous.sha256;
    } else {
      run('gh', ['release', 'create', `reader-v${candidate.version}`, archive, '--repo', process.env.GITHUB_REPOSITORY,
        '--target', process.env.SOURCE_SHA, '--title', `Deep Research Reader Beta ${candidate.version}`, '--prerelease',
        '--notes', `Deep Research Reader Beta ${candidate.version}.\n\nSHA-256: ${sha256}`]);
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${candidate.version}\nsha256=${sha256}\nurl=https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/reader-v${candidate.version}/${metadata.asset}\n`);
  }
}
