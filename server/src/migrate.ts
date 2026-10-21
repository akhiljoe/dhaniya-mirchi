// Apply db/migrations/*.sql in filename order, each exactly once, each in its
// own transaction. Runs as the one-shot `migrate` compose service before the
// api and worker start (design §14.2). An advisory lock makes two concurrent
// runs safe: the second waits, then finds nothing to do.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { MIGRATION_LOCK_ID } from './constants.js';
import { createDb, type Db } from './db.js';
import { createLogger, errorFields } from './logger.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url));

export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`create table if not exists schema_migrations (
      name        text primary key,
      applied_at  timestamptz not null default now()
    )`);
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}

// Entry point for the `migrate` service / `npm run migrate`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, production: config.production, service: 'migrate' });
  const db = createDb(config.databaseUrl);
  migrate(db)
    .then((applied) => {
      logger.info('migrations complete', { applied: applied.length, files: applied });
      return db.end();
    })
    .catch(async (err) => {
      logger.error('migrations failed', errorFields(err));
      await db.end();
      process.exit(1);
    });
}
