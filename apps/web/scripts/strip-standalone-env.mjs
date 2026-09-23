import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const distDir = process.env.NEXT_DIST_DIR ?? (process.env.NODE_ENV === 'development' ? '.next-dev' : '.next');
const standaloneDir = path.resolve(process.cwd(), distDir, 'standalone');

async function stripEnvironmentFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await stripEnvironmentFiles(entryPath);
    } else if (entry.name === '.env' || entry.name.startsWith('.env.')) {
      await rm(entryPath, { force: true });
    }
  }
}

await stripEnvironmentFiles(standaloneDir);
