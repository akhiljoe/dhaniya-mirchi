// Runs imports as they're queued (design §7.10), on the shared job loop. One
// at a time by default: an import holds a headless browser for many minutes.
// On shutdown, a running import puts its job back in the queue so the next
// worker resumes it at once (every step is idempotent). `onSweep` runs on
// every sweep, import running or not — the notices ride on it (notify.ts).
import { IMPORT_MAX_CONCURRENT, IMPORT_SWEEP_MS } from '../../constants.js';
import { startJobLoop, type JobLoop } from '../job-loop.js';
import { claimNextImport, runImport, type ImportDeps } from './import.js';

export function startImportLoop(
  deps: ImportDeps,
  databaseUrl: string,
  opts: { sweepMs?: number; maxConcurrent?: number; onSweep?: () => Promise<unknown> } = {},
): Promise<JobLoop> {
  return startJobLoop({
    name: 'import',
    channel: 'import_jobs',
    databaseUrl,
    logger: deps.logger,
    sweepMs: opts.sweepMs ?? IMPORT_SWEEP_MS,
    maxConcurrent: opts.maxConcurrent ?? IMPORT_MAX_CONCURRENT,
    beforeSweep: opts.onSweep,
    claim: () => claimNextImport(deps.db),
    run: (id, signal) => runImport({ ...deps, signal }, id),
  });
}
