import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ruleset } from '@ashamrai/flags-evaluator';
import type { RunningRelay } from '../../src/app';
import type { MemorySource } from '../../src/source';
import { memoryRelay, readSse, sseEvents } from './helpers';

let relay: RunningRelay;
let source: MemorySource;

function ruleset(version: number, on: boolean): Ruleset {
  return {
    env: 'production',
    version,
    flags: {
      visible: {
        key: 'visible',
        kind: 'boolean',
        salt: 's',
        clientSideAvailable: true,
        variations: [
          { id: 'on', value: true },
          { id: 'off', value: false },
        ],
        config: {
          on,
          offVariation: 'off',
          targets: [{ variation: 'on', contextKind: 'user', keys: ['secret-vip@corp.io'] }],
          rules: [
            {
              id: 'internal',
              clauses: [{ attribute: 'email', op: 'ends_with', values: ['@internal-codename.io'] }],
              serve: { variation: 'on' },
            },
          ],
          fallthrough: { variation: 'off' },
          version,
        },
      },
      hidden: {
        key: 'hidden',
        kind: 'boolean',
        salt: 's',
        clientSideAvailable: false,
        variations: [
          { id: 'on', value: true },
          { id: 'off', value: false },
        ],
        config: {
          on: true,
          offVariation: 'off',
          targets: [],
          rules: [],
          fallthrough: { variation: 'on' },
          version: 1,
        },
      },
    },
    segments: {},
  };
}

beforeAll(async () => {
  ({ relay, source } = await memoryRelay(100));
  source.keys.set('srv-1', { envId: 'env-1', kind: 'server' });
  source.keys.set('cli-1', { envId: 'env-1', kind: 'client' });
  source.snapshots.set('env-1', {
    envId: 'env-1',
    envKey: 'production',
    version: 1,
    ruleset: ruleset(1, true),
  });
});

afterAll(async () => {
  await relay.close();
});

async function bumpTo(version: number, on: boolean) {
  source.snapshots.set('env-1', {
    envId: 'env-1',
    envKey: 'production',
    version,
    ruleset: ruleset(version, on),
  });
  await relay.hub.handleNotification({
    type: 'flag.changed',
    envId: 'env-1',
    envKey: 'production',
    projectId: 'p',
    projectKey: 'p',
    flagKey: 'visible',
    version,
    envVersion: version,
    at: new Date().toISOString(),
  });
}

describe('relay protocol', () => {
  it('authenticates keys and enforces key kinds', async () => {
    expect((await fetch(`${relay.url}/sdk/v1/ruleset`)).status).toBe(401);
    expect((await fetch(`${relay.url}/sdk/v1/ruleset`, { headers: { authorization: 'nope' } })).status).toBe(
      401,
    );
    expect((await fetch(`${relay.url}/sdk/v1/ruleset`, { headers: { authorization: 'cli-1' } })).status).toBe(
      403,
    );
    expect(
      (
        await fetch(`${relay.url}/sdk/v1/evaluate`, {
          method: 'POST',
          headers: { authorization: 'srv-1', 'content-type': 'application/json' },
          body: '{"context":{"key":"u"}}',
        })
      ).status,
    ).toBe(403);
  });

  it('serves the ruleset with an ETag and answers 304 when unchanged', async () => {
    const first = await fetch(`${relay.url}/sdk/v1/ruleset`, { headers: { authorization: 'Bearer srv-1' } });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"\d+"$/);
    const body = (await first.json()) as Ruleset;
    expect(Object.keys(body.flags).sort()).toEqual(['hidden', 'visible']);
    const second = await fetch(`${relay.url}/sdk/v1/ruleset`, {
      headers: { authorization: 'srv-1', 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
  });

  it('never sends rules, targets or non client-side flags to client keys', async () => {
    const response = await fetch(`${relay.url}/sdk/v1/evaluate`, {
      method: 'POST',
      headers: { authorization: 'cli-1', 'content-type': 'application/json' },
      body: JSON.stringify({ context: { kind: 'user', key: 'u1', email: 'a@internal-codename.io' } }),
    });
    const text = await response.text();
    const body = JSON.parse(text);
    expect(Object.keys(body.flags)).toEqual(['visible']);
    expect(body.flags.visible).toEqual({ value: true, variationId: 'on', version: expect.any(Number) });
    for (const secret of ['internal-codename', 'secret-vip', 'clauses', 'salt', 'rules', 'targets'])
      expect(text).not.toContain(secret);
    expect(source.attributes.map((a) => a.name)).toContain('email');
  });

  it('streams put, patch and heartbeat to server SDKs', async () => {
    const text = await readSse(`${relay.url}/sdk/v1/stream`, { headers: { authorization: 'srv-1' } }, (t) => {
      if (
        t.includes('event: put') &&
        !t.includes('event: patch') &&
        !(globalThis as { bumped?: boolean }).bumped
      ) {
        (globalThis as { bumped?: boolean }).bumped = true;
        void bumpTo(2, false);
      }
      return t.includes('event: patch') && t.includes(':heartbeat');
    });
    const events = sseEvents(text);
    expect(events[0]!.event).toBe('put');
    const patch = events.find((e) => e.event === 'patch')!;
    expect(patch.data).toMatchObject({ kind: 'flag', key: 'visible', version: 2 });
    expect(patch.data.data.config.on).toBe(false);
  });

  it('streams re-evaluated values to client SDKs and only sends changed flags', async () => {
    const ctx = Buffer.from(JSON.stringify({ kind: 'user', key: 'u2' })).toString('base64url');
    let triggered = false;
    const text = await readSse(`${relay.url}/sdk/v1/client-stream?ctx=${ctx}&key=cli-1`, {}, (t) => {
      if (t.includes('event: put') && !triggered) {
        triggered = true;
        void bumpTo(3, true);
      }
      return t.includes('event: patch');
    });
    const events = sseEvents(text);
    expect(events[0]!.data.flags.visible.value).toBe(false);
    const patch = events.find((e) => e.event === 'patch')!;
    expect(patch.data.flags).toEqual({ visible: { value: false, variationId: 'off', version: 3 } });
  });

  it('sends a full put instead of a patch when notifications skip or reorder versions', async () => {
    const notify = (version: number, flagKey: string) =>
      relay.hub.handleNotification({
        type: 'flag.changed',
        envId: 'env-1',
        envKey: 'production',
        projectId: 'p',
        projectKey: 'p',
        flagKey,
        version,
        envVersion: version,
        at: new Date().toISOString(),
      });
    let stage = 0;
    const text = await readSse(`${relay.url}/sdk/v1/stream`, { headers: { authorization: 'srv-1' } }, (t) => {
      const puts = t.split('event: put').length - 1;
      if (puts === 1 && stage === 0) {
        stage = 1;
        source.snapshots.set('env-1', {
          envId: 'env-1',
          envKey: 'production',
          version: 5,
          ruleset: ruleset(5, false),
        });
        void notify(4, 'hidden').then(() => notify(5, 'visible'));
      }
      if (puts === 2 && stage === 1) {
        stage = 2;
        void bumpTo(6, true);
      }
      return stage === 2 && t.includes('event: patch');
    });
    const events = sseEvents(text);
    expect(events.map((e) => e.event)).toEqual(['put', 'put', 'patch']);
    expect(events[1]!.data.version).toBe(5);
    expect(events[1]!.data.ruleset.flags.visible.config.on).toBe(false);
    expect(events[2]!.data).toMatchObject({ kind: 'flag', key: 'visible', version: 6 });
  });

  it('rejects a client stream without a context', async () => {
    expect((await fetch(`${relay.url}/sdk/v1/client-stream?key=cli-1`)).status).toBe(400);
  });

  it('accepts event batches as JSON or text/plain beacons and validates them', async () => {
    const events = [
      {
        kind: 'exposure',
        flagKey: 'visible',
        variationId: 'on',
        contextKey: 'u1',
        inExperiment: true,
        ts: Date.now(),
      },
      { kind: 'custom', key: 'purchase', contextKey: 'u1', value: 9.5, ts: Date.now() },
      {
        kind: 'summary',
        startTs: Date.now() - 1000,
        endTs: Date.now(),
        counters: [{ flagKey: 'visible', variationId: 'on', count: 3 }],
      },
    ];
    const json = await fetch(`${relay.url}/sdk/v1/events`, {
      method: 'POST',
      headers: { authorization: 'srv-1', 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    expect(json.status).toBe(202);
    const beacon = await fetch(`${relay.url}/sdk/v1/events?key=cli-1`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ events }),
    });
    expect(beacon.status).toBe(202);
    const invalid = await fetch(`${relay.url}/sdk/v1/events`, {
      method: 'POST',
      headers: { authorization: 'srv-1', 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ kind: 'exposure' }] }),
    });
    expect(invalid.status).toBe(400);
    expect(source.ingested).toHaveLength(2);
  });

  it('answers CORS preflight and exposes Prometheus metrics', async () => {
    const preflight = await fetch(`${relay.url}/sdk/v1/evaluate`, {
      method: 'OPTIONS',
      headers: { origin: 'http://shop.local', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    const metrics = await (await fetch(`${relay.url}/metrics`)).text();
    expect(metrics).toContain('relay_sse_connections{kind="server"}');
    expect(metrics).toContain('relay_patches_sent_total');
  });
});
