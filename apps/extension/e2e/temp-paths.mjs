import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Cross-platform scratch space for the extension E2E scripts.
 *
 * macOS exposes its temporary directory as /private/tmp while Linux CI
 * runners only have /tmp. Hard-coding either path made the suite fail on
 * the other platform, so every artifact location goes through the
 * platform temporary directory instead.
 */
export function tempDir() {
  return tmpdir();
}

export function tempPath(...segments) {
  return join(tmpdir(), ...segments);
}
