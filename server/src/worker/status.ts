// Worker liveness: the worker writes a heartbeat, the api reads it (design §11
// — the two share only Postgres). `now` is passed in so the check is testable.
import { WORKER_STALE_AFTER_MS } from '../constants.js';
import type { Db } from '../db.js';

export interface WorkerStatus {
  alive: boolean;
  lastSeenAt: string | null;
  chromeVersion: string | null;
}

export async function recordHeartbeat(db: Db, info: { chromeVersion: string | null }): Promise<void> {
  await db.query(
    `insert into worker_status (id, last_heartbeat_at, chrome_version) values (1, now(), $1)
     on conflict (id) do update set last_heartbeat_at = now(), chrome_version = excluded.chrome_version`,
    [info.chromeVersion],
  );
}

export async function workerStatus(db: Db, now: Date): Promise<WorkerStatus> {
  const { rows } = await db.query<{ last_heartbeat_at: Date; chrome_version: string | null }>(
    'select last_heartbeat_at, chrome_version from worker_status where id = 1',
  );
  const row = rows[0];
  if (!row) return { alive: false, lastSeenAt: null, chromeVersion: null };
  return {
    alive: now.getTime() - row.last_heartbeat_at.getTime() <= WORKER_STALE_AFTER_MS,
    lastSeenAt: row.last_heartbeat_at.toISOString(),
    chromeVersion: row.chrome_version,
  };
}
