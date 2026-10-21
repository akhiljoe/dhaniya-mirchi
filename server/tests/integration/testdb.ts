// A throwaway `dhaniya_test` database on the compose Postgres, migrated fresh.
// Credentials come from the environment, else from the repo's .env (the same
// file docker compose reads), so `npm run test:integration` just works once
// `docker compose up -d postgres` is running.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { createDb, type Db } from '../../src/db.js';
import { migrate } from '../../src/migrate.js';

const TEST_DB = 'dhaniya_test';

function envValue(name: string, fallback: string): string {
  if (process.env[name]) return process.env[name]!;
  const file = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[1] === name && m[2] !== '') return m[2];
    }
  }
  return fallback;
}

function url(database: string): string {
  const user = envValue('POSTGRES_USER', 'dhaniya');
  const password = envValue('POSTGRES_PASSWORD', '');
  const port = envValue('POSTGRES_HOST_PORT', '5435');
  if (!password) throw new Error('POSTGRES_PASSWORD not set (env or .env) — is the compose Postgres configured?');
  return `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

// The test database URL — for code that opens its own connection (LISTEN).
export function testDatabaseUrl(): string {
  return url(TEST_DB);
}

// Drop and recreate the test database, then apply every migration.
export async function freshTestDb(): Promise<Db> {
  const admin = new pg.Client({ connectionString: url(envValue('POSTGRES_DB', 'dhaniya')) });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();
  const db = createDb(url(TEST_DB));
  await migrate(db);
  return db;
}
