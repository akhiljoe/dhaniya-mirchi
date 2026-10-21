// A worker job loop (design §7.10, §11): wake on NOTIFY, sweep on a timer,
// claim and run jobs up to a concurrency limit, stop promptly. Connect
// attempts and imports both run on it.
//
// The api announces work with NOTIFY; the sweep catches anything announced
// while the worker was down or between LISTENs. On stop, the AbortSignal
// handed to every running job fires — each job decides what "interrupted"
// means for it (a connect attempt ends; an import goes back in the queue).
import pg from 'pg';

import { errorFields, type Logger } from '../logger.js';

export interface JobLoop {
  stop(): Promise<void>;
}

export interface JobLoopOptions {
  name: string; // for logs
  channel: string; // the NOTIFY channel announcing new work
  databaseUrl: string;
  logger: Logger;
  sweepMs: number;
  maxConcurrent: number;
  beforeSweep?: () => Promise<unknown>; // housekeeping, e.g. expiring stale rows
  claim: () => Promise<string | null>;
  run: (id: string, signal: AbortSignal) => Promise<void>;
}

export async function startJobLoop(o: JobLoopOptions): Promise<JobLoop> {
  let running = true;
  let inFlight = 0;
  const abort = new AbortController();
  const jobs = new Set<Promise<void>>();
  let wake: () => void = () => undefined;

  // A dedicated connection for LISTEN (pool connections are shared and reused).
  const listener = new pg.Client({ connectionString: o.databaseUrl });
  await listener.connect();
  listener.on('notification', () => wake());
  listener.on('error', (err) => o.logger.warn(`${o.name} loop: listener error`, errorFields(err)));
  await listener.query(`listen ${o.channel}`);

  const loop = (async () => {
    while (running) {
      try {
        await o.beforeSweep?.();
        while (running && inFlight < o.maxConcurrent) {
          const id = await o.claim();
          if (!id) break;
          inFlight++;
          const job = o
            .run(id, abort.signal)
            .catch((err) => o.logger.error(`${o.name} loop: job crashed`, { job: id, ...errorFields(err) }))
            .finally(() => {
              inFlight--;
              jobs.delete(job);
              wake();
            });
          jobs.add(job);
        }
      } catch (err) {
        o.logger.error(`${o.name} loop: sweep failed`, errorFields(err));
      }
      if (!running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, o.sweepMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();

  return {
    async stop() {
      running = false;
      abort.abort();
      wake();
      await loop;
      await Promise.allSettled([...jobs]);
      await listener.end().catch(() => undefined);
    },
  };
}
