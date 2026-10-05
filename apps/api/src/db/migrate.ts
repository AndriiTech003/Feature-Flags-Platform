import type { Db } from './db';
import { migrations } from './migrations';

export async function migrate(db: Db): Promise<string[]> {
  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const done: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      done.push(migration.name);
    }
    await client.query('SELECT pg_advisory_unlock(424242)');
    await ensurePartitions(db);
    return done;
  } finally {
    client.release();
  }
}

export async function ensurePartitions(db: Db, pastDays = 30, futureDays = 7): Promise<number> {
  const row = await db.one<{ created: number }>(
    'SELECT ensure_event_partitions((current_date - $1::int)::date, $2::int) AS created',
    [pastDays, pastDays + futureDays + 1],
  );
  return row.created;
}

export async function createDatabase(adminUrl: string, name: string): Promise<void> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name.replace(/"/g, '')}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

export function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
