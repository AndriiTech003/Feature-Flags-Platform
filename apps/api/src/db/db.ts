import pg from 'pg';

pg.types.setTypeParser(20, (value) => Number(value));
pg.types.setTypeParser(1700, (value) => Number(value));

export type Row = Record<string, unknown>;

export interface Sql {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  one<T = Row>(text: string, params?: unknown[]): Promise<T>;
  maybe<T = Row>(text: string, params?: unknown[]): Promise<T | undefined>;
}

class ClientSql implements Sql {
  constructor(private readonly client: pg.PoolClient | pg.Pool) {}

  async query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.client.query(text, params);
    return result.rows as T[];
  }

  async one<T = Row>(text: string, params: unknown[] = []): Promise<T> {
    const rows = await this.query<T>(text, params);
    if (rows.length === 0) throw new Error('expected one row');
    return rows[0]!;
  }

  async maybe<T = Row>(text: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(text, params);
    return rows[0];
  }
}

export class Db implements Sql {
  readonly pool: pg.Pool;
  private readonly sql: ClientSql;

  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({ connectionString, max });
    this.pool.on('error', () => undefined);
    this.sql = new ClientSql(this.pool);
  }

  query<T = Row>(text: string, params?: unknown[]): Promise<T[]> {
    return this.sql.query<T>(text, params);
  }

  one<T = Row>(text: string, params?: unknown[]): Promise<T> {
    return this.sql.one<T>(text, params);
  }

  maybe<T = Row>(text: string, params?: unknown[]): Promise<T | undefined> {
    return this.sql.maybe<T>(text, params);
  }

  async tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    const onError = (error: Error) => {
      broken = error;
    };
    client.on('error', onError);
    try {
      await client.query('BEGIN');
      const result = await fn(new ClientSql(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        broken ??= rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      });
      throw error;
    } finally {
      client.off('error', onError);
      client.release(broken);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
