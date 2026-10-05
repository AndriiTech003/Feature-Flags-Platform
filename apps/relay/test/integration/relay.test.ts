import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp, loadConfig, type RunningApi } from '@ffp/api';
import { init, silentLogger, type FlagsClient } from '@ashamrai/flags-node';
import { createRelay, type RunningRelay } from '../../src/app';
import { loadRelayConfig } from '../../src/config';
import { openStream as open } from './stream';

let api: RunningApi;
let relay: RunningRelay;
let token: string;
const openStream = (path: string, key: string) => open(relay.url, path, key);
const project = `relay-${Math.random().toString(36).slice(2, 8)}`;
const keys: Record<string, string> = {};

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  const shared = {
    databaseUrl: inject('databaseUrl'),
    redisUrl: inject('redisUrl'),
    redisPrefix: inject('redisPrefix'),
  };
  api = await createApp(
    { ...loadConfig({}), ...shared, port: 0, jwtSecret: 'relay-test', workerEnabled: false },
    { migrate: false },
  );
  relay = await createRelay({
    ...loadRelayConfig({}),
    ...shared,
    port: 0,
    heartbeatMs: 1000,
    versionCheckMs: 60000,
    keyCacheTtlMs: 200,
  });
  const signup = await fetch(`${api.url}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${project}@test.dev`, password: 'password123', name: 'Relay Tester' }),
  });
  token = ((await signup.json()) as { token: string }).token;
  await call('POST', '/projects', { key: project, name: 'Relay' });
  keys.server = (
    await call('POST', `/projects/${project}/envs/production/sdk-keys`, { kind: 'server' })
  ).body.key;
  keys.client = (
    await call('POST', `/projects/${project}/envs/production/sdk-keys`, { kind: 'client' })
  ).body.key;
  await call('POST', `/projects/${project}/flags`, {
    key: 'checkout',
    name: 'Checkout',
    clientSideAvailable: true,
  });
  await call('POST', `/projects/${project}/flags`, { key: 'internal-only', name: 'Internal' });
});

afterAll(async () => {
  await relay?.close();
  await api?.close();
});

describe('relay with API, Postgres and Redis', () => {
  it('delivers a patch to SSE subscribers in under 500 ms after a flag change', async () => {
    const stream = await openStream('/sdk/v1/stream', keys.server!);
    const put = await stream.waitFor((e) => e.event === 'put');
    expect(Object.keys(put.data.ruleset.flags).sort()).toEqual(['checkout', 'internal-only']);
    const { monitorEventLoopDelay } = await import('node:perf_hooks');
    const loopDelay = monitorEventLoopDelay({ resolution: 5 });
    loopDelay.enable();
    for (let i = 0; i < 3; i++) await call('GET', `/projects/${project}/flags/checkout/envs/production`);
    const latencies: number[] = [];
    const roundTrips: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const patched = await call('PATCH', `/projects/${project}/flags/checkout/envs/production`, [
        { kind: i % 2 === 0 ? 'turnOn' : 'turnOff' },
      ]);
      const committed = performance.now();
      expect(patched.status).toBe(200);
      const patch = await stream.waitFor(
        (e) => e.event === 'patch' && e.data.data?.config?.version === patched.body.version,
      );
      latencies.push(Math.max(0, patch.at - committed));
      roundTrips.push(patch.at - started);
      expect(patch.data.data.config.on).toBe(i % 2 === 0);
    }
    stream.close();
    expect(Math.max(...latencies)).toBeLessThan(500);
    expect(Math.max(...roundTrips)).toBeLessThan(500);
    loopDelay.disable();
    process.stdout.write(`event loop delay max ${(loopDelay.max / 1e6).toFixed(1)} ms\n`);
    process.stdout.write(
      `patch delivery after commit (ms): ${latencies.map((l) => l.toFixed(1)).join(', ')}; including API request: ${roundTrips.map((l) => l.toFixed(1)).join(', ')}\n`,
    );
  });

  it('serves the ruleset with ETag/304 and bumps the version on change', async () => {
    const first = await fetch(`${relay.url}/sdk/v1/ruleset`, { headers: { authorization: keys.server! } });
    const etag = first.headers.get('etag')!;
    expect(
      (
        await fetch(`${relay.url}/sdk/v1/ruleset`, {
          headers: { authorization: keys.server!, 'if-none-match': etag },
        })
      ).status,
    ).toBe(304);
    await call('PATCH', `/projects/${project}/flags/checkout/envs/production`, [
      { kind: 'addTargets', variationId: 'on', keys: ['vip'] },
    ]);
    await new Promise((r) => setTimeout(r, 100));
    const changed = await fetch(`${relay.url}/sdk/v1/ruleset`, {
      headers: { authorization: keys.server!, 'if-none-match': etag },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  it('updates the Node SDK through the real stream and client SDK streams through client-stream', async () => {
    const client: FlagsClient = init({
      sdkKey: keys.server!,
      baseUrl: relay.url,
      logger: silentLogger,
      events: { flushIntervalMs: 100 },
    });
    try {
      expect((await client.waitForInitialization({ timeoutMs: 3000 })).initialized).toBe(true);
      const ctx = { kind: 'user', key: 'shopper-1' };
      const clientCtx = Buffer.from(JSON.stringify(ctx)).toString('base64url');
      const clientStream = await openStream(`/sdk/v1/client-stream?ctx=${clientCtx}`, keys.client!);
      const clientPut = await clientStream.waitFor((e) => e.event === 'put');
      expect(Object.keys(clientPut.data.flags)).toEqual(['checkout']);
      const updated = new Promise<string>((resolve) => client.on('update', (u) => resolve(u.key)));
      await call('PATCH', `/projects/${project}/flags/checkout/envs/production`, [
        { kind: 'turnOn' },
        { kind: 'updateFallthrough', serve: { variation: 'on' } },
      ]);
      expect(await updated).toBe('checkout');
      expect(client.boolVariation('checkout', ctx, false)).toBe(true);
      const patch = await clientStream.waitFor(
        (e) => e.event === 'patch' && e.data.flags.checkout?.value === true,
      );
      expect(patch.data.flags.checkout.variationId).toBe('on');
      clientStream.close();
      client.track('purchase', ctx, { value: 10 });
      await client.flush();
    } finally {
      await client.close();
    }
    const insights = await call('GET', `/projects/${project}/flags/checkout/insights?env=production`);
    expect(insights.body.last24h.reduce((s: number, x: { count: number }) => s + x.count, 0)).toBeGreaterThan(
      0,
    );
    expect(insights.body.lastEvaluatedAt).not.toBeNull();
    const attributes = await call('GET', `/projects/${project}/context-attributes?env=production`);
    expect(Array.isArray(attributes.body.items)).toBe(true);
  });

  it('keeps a rotated key valid during the grace period and rejects revoked keys', async () => {
    const created = await call('POST', `/projects/${project}/envs/production/sdk-keys`, { kind: 'server' });
    expect(
      (await fetch(`${relay.url}/sdk/v1/ruleset`, { headers: { authorization: created.body.key } })).status,
    ).toBe(200);
    const rotated = await call(
      'POST',
      `/projects/${project}/envs/production/sdk-keys/${created.body.id}/rotate`,
      { gracePeriodMinutes: 10 },
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(
      (await fetch(`${relay.url}/sdk/v1/ruleset`, { headers: { authorization: created.body.key } })).status,
    ).toBe(200);
    expect(
      (await fetch(`${relay.url}/sdk/v1/ruleset`, { headers: { authorization: rotated.body.current.key } }))
        .status,
    ).toBe(200);
    await call('DELETE', `/projects/${project}/envs/production/sdk-keys/${created.body.id}`);
    await new Promise((r) => setTimeout(r, 300));
    expect(
      (await fetch(`${relay.url}/sdk/v1/ruleset`, { headers: { authorization: created.body.key } })).status,
    ).toBe(401);
  });

  it('client evaluate returns only client-side flags without targeting rules', async () => {
    await call('PATCH', `/projects/${project}/flags/checkout/envs/production`, [
      {
        kind: 'addRule',
        rule: {
          clauses: [{ attribute: 'email', op: 'ends_with', values: ['@secret-partner.com'] }],
          serve: { variation: 'on' },
        },
      },
    ]);
    const response = await fetch(`${relay.url}/sdk/v1/evaluate`, {
      method: 'POST',
      headers: { authorization: keys.client!, 'content-type': 'application/json' },
      body: JSON.stringify({ context: { kind: 'user', key: 'x', email: 'a@b.c' } }),
    });
    const text = await response.text();
    expect(Object.keys(JSON.parse(text).flags)).toEqual(['checkout']);
    expect(text).not.toContain('secret-partner');
    expect(text).not.toContain('internal-only');
  });
});
