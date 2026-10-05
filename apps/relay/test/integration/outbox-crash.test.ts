import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp, loadConfig, type RunningApi } from '@ffp/api';
import { createRelay, type RunningRelay } from '../../src/app';
import { loadRelayConfig } from '../../src/config';
import { openStream } from './stream';

const publisherEntry = fileURLToPath(new URL('../../../api/dist/outbox-main.js', import.meta.url));
const shared = {
  databaseUrl: inject('databaseUrl'),
  redisUrl: inject('redisUrl'),
  redisPrefix: `${inject('redisPrefix')}_crash`,
};
const project = `crash-${Math.random().toString(36).slice(2, 8)}`;
let api: RunningApi;
let relay: RunningRelay;
let db: pg.Pool;
let token: string;
let serverKey: string;
const children = new Set<ChildProcess>();

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

function startPublisher(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [publisherEntry], {
    env: {
      ...process.env,
      DATABASE_URL: shared.databaseUrl,
      REDIS_URL: shared.redisUrl,
      REDIS_PREFIX: shared.redisPrefix,
      OUTBOX_POLL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`publisher did not start: ${output}`)), 15000);
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('outbox publisher running')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`publisher exited with ${code}: ${output}`));
    });
  });
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function pending(): Promise<number> {
  const result = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM change_outbox WHERE payload->>'projectKey' = $1",
    [project],
  );
  return result.rows[0]!.count;
}

beforeAll(async () => {
  db = new pg.Pool({ connectionString: shared.databaseUrl, max: 2 });
  api = await createApp(
    {
      ...loadConfig({}),
      ...shared,
      port: 0,
      jwtSecret: 'crash-test',
      workerEnabled: false,
      outboxPublisher: false,
    },
    { migrate: false },
  );
  relay = await createRelay({
    ...loadRelayConfig({}),
    ...shared,
    port: 0,
    heartbeatMs: 1000,
    versionCheckMs: 60000,
  });
  const signup = await fetch(`${api.url}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${project}@test.dev`, password: 'password123', name: 'Crash Tester' }),
  });
  token = ((await signup.json()) as { token: string }).token;
  await call('POST', '/projects', { key: project, name: 'Crash' });
  serverKey = (await call('POST', `/projects/${project}/envs/production/sdk-keys`, { kind: 'server' })).body
    .key;
  await call('POST', `/projects/${project}/flags`, { key: 'checkout', name: 'Checkout' });
});

afterAll(async () => {
  for (const child of [...children]) {
    child.kill('SIGKILL');
    await exited(child);
  }
  await relay?.close();
  await api?.close();
  await db?.end();
});

describe('transactional outbox with a separate publisher process', () => {
  it('delivers a committed change quickly after the publisher is killed between commit and publish', async () => {
    const first = await startPublisher();
    const stream = await openStream(relay.url, '/sdk/v1/stream', serverKey);
    await stream.waitFor((e) => e.event === 'put');
    const warm = await call('PATCH', `/projects/${project}/flags/checkout/envs/production`, [
      { kind: 'turnOn' },
    ]);
    expect(warm.status).toBe(200);
    await stream.waitFor(
      (e) => e.event === 'patch' && e.data.data?.config?.version === warm.body.version,
      3000,
    );

    first.kill('SIGSTOP');
    const committed = await call('PATCH', `/projects/${project}/flags/checkout/envs/production`, [
      { kind: 'turnOff' },
    ]);
    expect(committed.status).toBe(200);
    const isCommittedPatch = (e: { event: string; data: any }) =>
      e.event === 'patch' && e.data.data?.config?.version === committed.body.version;
    expect(await pending()).toBe(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(stream.events.some(isCommittedPatch)).toBe(false);
    first.kill('SIGKILL');
    await exited(first);
    await new Promise((r) => setTimeout(r, 300));
    expect(stream.events.some(isCommittedPatch)).toBe(false);
    expect(await pending()).toBe(1);

    const restartedAt = performance.now();
    await startPublisher();
    const patch = await stream.waitFor(isCommittedPatch, 10000);
    const afterRestart = patch.at - restartedAt;
    expect(patch.data.data.config.on).toBe(false);
    expect(afterRestart).toBeLessThan(3000);
    expect(await pending()).toBe(0);
    stream.close();
    process.stdout.write(
      `patch delivered ${afterRestart.toFixed(0)} ms after restarting the killed publisher (relay recheck interval 60 s)\n`,
    );
  });
});
