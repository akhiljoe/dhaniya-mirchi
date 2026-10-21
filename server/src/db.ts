// The PostgreSQL pool. The api and the worker each hold their own; they never
// share a connection or talk directly — only through rows and LISTEN/NOTIFY
// (design §11).
import pg from 'pg';

export type Db = pg.Pool;

export function createDb(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl });
}
