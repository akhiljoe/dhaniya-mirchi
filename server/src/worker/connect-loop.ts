// Runs connect attempts as they arrive (design §7.10), on the shared job loop.
// At most CONNECT_MAX_CONCURRENT at once — each holds a headless browser
// inside the worker's memory cap. On shutdown, an attempt waiting for a code
// ends as `interrupted` (its browser goes with the worker).
import { CONNECT_MAX_CONCURRENT, CONNECT_SWEEP_MS } from '../constants.js';
import { claimNextRequest, expireStaleRequests, runConnect, type ConnectDeps } from './connect.js';
import { startJobLoop, type JobLoop } from './job-loop.js';

export type ConnectLoop = JobLoop;

export function startConnectLoop(
  deps: ConnectDeps,
  databaseUrl: string,
  opts: { sweepMs?: number; maxConcurrent?: number } = {},
): Promise<ConnectLoop> {
  return startJobLoop({
    name: 'connect',
    channel: 'connect_requests',
    databaseUrl,
    logger: deps.logger,
    sweepMs: opts.sweepMs ?? CONNECT_SWEEP_MS,
    maxConcurrent: opts.maxConcurrent ?? CONNECT_MAX_CONCURRENT,
    beforeSweep: () => expireStaleRequests(deps.db),
    claim: () => claimNextRequest(deps.db),
    run: (id, signal) => runConnect({ ...deps, signal }, id),
  });
}
