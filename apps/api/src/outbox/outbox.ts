import pg from 'pg';
import { changesChannel, sdkKeysChannel, type ChangeNotification } from '@ashamrai/flags-contracts';
import type { Db, Sql } from '../db/db';

export const OUTBOX_CHANNEL = 'ffp_change_outbox';

export type OutboxTopic = 'changes' | 'sdk-keys';

export type OutboxMessage =
  { topic: 'changes'; payload: ChangeNotification } | { topic: 'sdk-keys'; payload: { envId: string } };

export async function enqueueOutbox(sql: Sql, message: OutboxMessage): Promise<void> {
  await sql.query('INSERT INTO change_outbox (topic, payload) VALUES ($1, $2)', [
    message.topic,
    JSON.stringify(message.payload),
  ]);
  await sql.query('SELECT pg_notify($1, $2)', [OUTBOX_CHANNEL, message.topic]);
}

export function outboxRedisChannel(prefix: string, topic: OutboxTopic): string {
  return topic === 'changes' ? changesChannel(prefix) : sdkKeysChannel(prefix);
}

export type PublishFn = (topic: OutboxTopic, payload: string) => Promise<void>;

export interface OutboxPublisherOptions {
  db: Db;
  listenUrl: string;
  publish: PublishFn;
  pollIntervalMs?: number;
  batchSize?: number;
  publishTimeoutMs?: number;
  reconnectDelayMs?: number;
  onError?: (error: Error) => void;
}

export interface OutboxMetrics {
  published: number;
  failures: number;
  drains: number;
  wakeups: number;
  listening: boolean;
  lastPublishedAt: string | null;
  lastError: string | null;
}

interface OutboxRow {
  id: number;
  topic: OutboxTopic;
  payload: unknown;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`publish timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class OutboxPublisher {
  readonly metrics: OutboxMetrics = {
    published: 0,
    failures: 0,
    drains: 0,
    wakeups: 0,
    listening: false,
    lastPublishedAt: null,
    lastError: null,
  };
  private listener: pg.Client | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly publishTimeoutMs: number;
  private readonly reconnectDelayMs: number;

  constructor(private readonly options: OutboxPublisherOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.batchSize = options.batchSize ?? 100;
    this.publishTimeoutMs = options.publishTimeoutMs ?? 2000;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 500;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.listen().catch((error: unknown) => this.report(error));
    this.pollTimer = setInterval(() => this.wake(), this.pollIntervalMs);
    this.pollTimer.unref();
    await this.drain();
  }

  private report(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.metrics.lastError = failure.message;
    this.options.onError?.(failure);
  }

  private async listen(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.options.listenUrl });
    const lost = () => {
      if (this.listener !== client) return;
      this.listener = null;
      this.metrics.listening = false;
      client.removeAllListeners('notification');
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    client.on('error', (error) => {
      this.report(error);
      lost();
    });
    client.on('end', lost);
    client.on('notification', () => {
      this.metrics.wakeups++;
      this.wake();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
    } catch (error) {
      client.removeAllListeners();
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
      throw error;
    }
    if (this.stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    this.listener = client;
    this.metrics.listening = true;
    this.wake();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.listen().catch((error: unknown) => this.report(error));
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref();
  }

  wake(): void {
    if (this.stopped) return;
    void this.drain();
  }

  drain(): Promise<void> {
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = (async () => {
      do {
        this.again = false;
        try {
          for (;;) {
            if (this.stopped) break;
            const result = await this.drainOnce();
            if (result.failure) {
              this.metrics.failures++;
              this.report(result.failure);
              break;
            }
            if (result.claimed < this.batchSize) break;
          }
        } catch (error) {
          this.metrics.failures++;
          this.report(error);
        }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  async drainOnce(): Promise<{ claimed: number; published: number; failure: unknown }> {
    this.metrics.drains++;
    return this.options.db.tx(async (sql) => {
      const rows = await sql.query<OutboxRow>(
        'SELECT id, topic, payload FROM change_outbox ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
        [this.batchSize],
      );
      if (rows.length === 0) return { claimed: 0, published: 0, failure: null };
      const published: number[] = [];
      let failure: unknown = null;
      for (const row of rows) {
        try {
          await withTimeout(
            this.options.publish(row.topic, JSON.stringify(row.payload)),
            this.publishTimeoutMs,
          );
          published.push(row.id);
        } catch (error) {
          failure = error;
          await sql.query('UPDATE change_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [
            row.id,
            error instanceof Error ? error.message : String(error),
          ]);
          break;
        }
      }
      if (published.length > 0) {
        await sql.query('DELETE FROM change_outbox WHERE id = ANY($1::bigint[])', [published]);
        this.metrics.published += published.length;
        this.metrics.lastPublishedAt = new Date().toISOString();
      }
      return { claimed: rows.length, published: published.length, failure };
    });
  }

  async pending(): Promise<number> {
    const row = await this.options.db.one<{ count: number }>(
      'SELECT count(*)::int AS count FROM change_outbox',
    );
    return row.count;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
    const listener = this.listener;
    this.listener = null;
    this.metrics.listening = false;
    if (listener) {
      listener.removeAllListeners('end');
      await listener.end().catch(() => undefined);
    }
    if (this.draining) await this.draining.catch(() => undefined);
  }
}
