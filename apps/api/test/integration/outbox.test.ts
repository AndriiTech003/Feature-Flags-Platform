import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { changesChannel } from '@ashamrai/flags-contracts';
import type { RunningApi } from '../../src/app';
import { Db } from '../../src/db/db';
import { enqueueOutbox, OutboxPublisher, outboxRedisChannel, type PublishFn } from '../../src/outbox/outbox';
import { ApiClient, startApi, uniqueKey } from './helpers';

let api: RunningApi;
let admin: ApiClient;
let db: Db;
let redis: Redis;
let subscriber: Redis;
let project: string;
const received: Array<{ message: Record<string, unknown>; at: number }> = [];
const publishers: OutboxPublisher[] = [];
const extraDbs: Db[] = [];

const prefix = `${inject('redisPrefix')}_outbox`;

function urlWithName(name: string): string {
  const url = new URL(inject('databaseUrl'));
  url.searchParams.set('application_name', name);
  return url.toString();
}

const redisPublish: PublishFn = async (topic, payload) => {
  await redis.publish(outboxRedisChannel(prefix, topic), payload);
};

function publisher(options: Partial<ConstructorParameters<typeof OutboxPublisher>[0]> = {}): OutboxPublisher {
  const p = new OutboxPublisher({ db, listenUrl: inject('databaseUrl'), publish: redisPublish, ...options });
  publishers.push(p);
  return p;
}

async function outboxRows(marker: string): Promise<number> {
  const row = await db.one<{ count: number }>(
    "SELECT count(*)::int AS count FROM change_outbox WHERE payload->>'projectKey' = $1",
    [marker],
  );
  return row.count;
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function notification(marker: string, n: number) {
  return {
    topic: 'changes' as const,
    payload: {
      type: 'flag.changed' as const,
      envId: '00000000-0000-0000-0000-000000000000',
      envKey: 'test',
      projectId: marker,
      projectKey: marker,
      flagKey: `f${n}`,
      version: n,
      envVersion: n,
      at: new Date().toISOString(),
    },
  };
}

async function drainAll(): Promise<void> {
  const p = publisher({ pollIntervalMs: 60000 });
  await p.start();
  await p.stop();
}

beforeAll(async () => {
  db = new Db(inject('databaseUrl'), 5);
  redis = new Redis(inject('redisUrl'));
  subscriber = new Redis(inject('redisUrl'));
  await subscriber.subscribe(changesChannel(prefix));
  subscriber.on('message', (_channel: string, message: string) => {
    received.push({ message: JSON.parse(message) as Record<string, unknown>, at: performance.now() });
  });
  api = await startApi({ outboxPublisher: false, redisPrefix: prefix });
  admin = new ApiClient(api.url);
  await admin.signup(`${uniqueKey('outbox')}@test.dev`, 'Olga Outbox');
  project = uniqueKey('outbox');
  expect((await admin.post('/projects', { key: project, name: 'Outbox' })).status).toBe(201);
  expect((await admin.post(`/projects/${project}/flags`, { key: 'gate', name: 'Gate' })).status).toBe(201);
});

afterAll(async () => {
  for (const p of publishers) await p.stop();
  await api?.close();
  for (const extra of extraDbs) await extra.close();
  await Promise.allSettled([subscriber?.quit(), redis?.quit()]);
  await db?.close();
});

describe('transactional outbox', () => {
  it('writes the notification in the same transaction as the configuration change', async () => {
    await drainAll();
    expect(await outboxRows(project)).toBe(0);
    const patched = await admin.patch(`/projects/${project}/flags/gate/envs/production`, [
      { kind: 'turnOn' },
    ]);
    expect(patched.status).toBe(200);
    const rows = await db.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM change_outbox WHERE payload->>'projectKey' = $1",
      [project],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      type: 'flag.changed',
      flagKey: 'gate',
      envKey: 'production',
      version: patched.body.version,
      actor: { name: 'Olga Outbox' },
    });
    const env = await db.one<{ version: number }>(
      "SELECT e.version FROM environments e JOIN projects p ON p.id = e.project_id WHERE p.key = $1 AND e.key = 'production'",
      [project],
    );
    expect(rows[0]!.payload.envVersion).toBe(env.version);
  });

  it('writes nothing when the change is rolled back', async () => {
    await drainAll();
    const stale = await admin.patch(
      `/projects/${project}/flags/gate/envs/production`,
      [{ kind: 'turnOff' }],
      {
        'if-match': '"1"',
      },
    );
    expect(stale.status).toBe(409);
    const invalid = await admin.patch(`/projects/${project}/flags/gate/envs/production`, [
      { kind: 'updateFallthrough', serve: { variation: 'missing' } },
    ]);
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(await outboxRows(project)).toBe(0);
  });

  it('records segment, environment, flag lifecycle and SDK key changes in the outbox', async () => {
    await drainAll();
    const base = `/projects/${project}`;
    expect(
      (await admin.post(`${base}/envs/staging/segments`, { key: 'beta', name: 'Beta', included: ['u1'] }))
        .status,
    ).toBe(201);
    expect((await admin.patch(`${base}/environments/staging`, { color: '#123456' })).status).toBe(200);
    expect((await admin.post(`${base}/flags`, { key: 'lifecycle', name: 'Lifecycle' })).status).toBe(201);
    const types = (
      await db.query<{ type: string }>(
        "SELECT payload->>'type' AS type FROM change_outbox WHERE payload->>'projectKey' = $1 ORDER BY id",
        [project],
      )
    ).map((r) => r.type);
    expect(types).toEqual(['segment.changed', 'env.changed', 'flag.changed', 'flag.changed', 'flag.changed']);
    const key = await admin.post(`${base}/envs/production/sdk-keys`, { kind: 'server' });
    const before = await db.one<{ count: number }>(
      "SELECT count(*)::int AS count FROM change_outbox WHERE topic = 'sdk-keys'",
    );
    expect((await admin.request('DELETE', `${base}/envs/production/sdk-keys/${key.body.id}`)).status).toBe(
      204,
    );
    const after = await db.one<{ count: number }>(
      "SELECT count(*)::int AS count FROM change_outbox WHERE topic = 'sdk-keys'",
    );
    expect(after.count).toBe(before.count + 1);
  });

  it('wakes up on LISTEN/NOTIFY instead of waiting for the poll interval', async () => {
    await drainAll();
    const p = publisher({ pollIntervalMs: 60000, listenUrl: urlWithName('ffp-outbox-listener') });
    await p.start();
    expect(p.metrics.listening).toBe(true);
    const marker = uniqueKey('notify');
    const started = performance.now();
    await db.tx((sql) => enqueueOutbox(sql, notification(marker, 1)));
    const delivered = await waitFor(() => received.find((r) => r.message.projectKey === marker), 2000);
    expect(delivered.at - started).toBeLessThan(250);
    expect(p.metrics.wakeups).toBeGreaterThan(0);
    await db.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'ffp-outbox-listener'",
    );
    await waitFor(() => !p.metrics.listening, 2000);
    await waitFor(() => p.metrics.listening, 3000);
    const again = uniqueKey('notify');
    const restarted = performance.now();
    await db.tx((sql) => enqueueOutbox(sql, notification(again, 2)));
    const second = await waitFor(() => received.find((r) => r.message.projectKey === again), 2000);
    expect(second.at - restarted).toBeLessThan(250);
    await p.stop();
  });

  it('publishes every row exactly once with concurrent publishers using SKIP LOCKED', async () => {
    await drainAll();
    const marker = uniqueKey('concurrent');
    const total = 300;
    const ps = [1, 2, 3].map(() => publisher({ pollIntervalMs: 20, batchSize: 7 }));
    await Promise.all(ps.map((p) => p.start()));
    for (let i = 0; i < total; i += 10) {
      await db.tx(async (sql) => {
        for (let j = i; j < i + 10; j++) await enqueueOutbox(sql, notification(marker, j));
      });
    }
    await waitFor(() => received.filter((r) => r.message.projectKey === marker).length >= total, 10000);
    await new Promise((r) => setTimeout(r, 200));
    const versions = received.filter((r) => r.message.projectKey === marker).map((r) => r.message.version);
    expect(versions).toHaveLength(total);
    expect(new Set(versions).size).toBe(total);
    expect(ps.filter((p) => p.metrics.published > 0).length).toBeGreaterThan(1);
    expect(await outboxRows(marker)).toBe(0);
    await Promise.all(ps.map((p) => p.stop()));
  });

  it('keeps rows that failed to publish and retries them', async () => {
    await drainAll();
    let failures = 1;
    const flaky: PublishFn = async (topic, payload) => {
      if (failures-- > 0) throw new Error('redis unavailable');
      await redisPublish(topic, payload);
    };
    const p = publisher({ pollIntervalMs: 100, publish: flaky });
    const marker = uniqueKey('retry');
    await db.tx((sql) => enqueueOutbox(sql, notification(marker, 1)));
    await p.drainOnce().then((result) => expect(result).toMatchObject({ claimed: 1, published: 0 }));
    const kept = await db.one<{ attempts: number; last_error: string }>(
      "SELECT attempts, last_error FROM change_outbox WHERE payload->>'projectKey' = $1",
      [marker],
    );
    expect(kept).toEqual({ attempts: 1, last_error: 'redis unavailable' });
    await p.start();
    await waitFor(() => received.find((r) => r.message.projectKey === marker), 3000);
    expect(await outboxRows(marker)).toBe(0);
    await p.stop();
  });

  it('a publisher that dies after claiming rows loses nothing: locks are released and another publisher delivers', async () => {
    await drainAll();
    const victimDb = new Db(urlWithName('ffp-outbox-victim'), 1);
    extraDbs.push(victimDb);
    let claimed = false;
    let release: () => void = () => undefined;
    const hang: PublishFn = () => {
      claimed = true;
      return new Promise<void>((resolve) => (release = resolve));
    };
    const victim = publisher({
      db: victimDb,
      publish: hang,
      pollIntervalMs: 60000,
      publishTimeoutMs: 600000,
    });
    const marker = uniqueKey('crash');
    await db.tx((sql) => enqueueOutbox(sql, notification(marker, 1)));
    void victim.start();
    await waitFor(() => claimed, 3000);
    const survivor = publisher({ pollIntervalMs: 60000 });
    await survivor.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(received.find((r) => r.message.projectKey === marker)).toBeUndefined();
    expect(await outboxRows(marker)).toBe(1);
    await db.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'ffp-outbox-victim'",
    );
    const killedAt = performance.now();
    survivor.wake();
    const delivered = await waitFor(() => received.find((r) => r.message.projectKey === marker), 3000);
    expect(delivered.at - killedAt).toBeLessThan(1000);
    release();
    await victim.stop();
    await survivor.stop();
    expect(received.filter((r) => r.message.projectKey === marker)).toHaveLength(1);
  });
});
