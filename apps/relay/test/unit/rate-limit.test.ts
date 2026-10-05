import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ruleset } from '@ashamrai/flags-evaluator';
import type { RunningRelay } from '../../src/app';
import { defaultRateLimits, loadRateLimits, loadRelayConfig } from '../../src/config';
import {
  parsePolicy,
  RelayRateLimits,
  retryAfterSeconds,
  TokenBucketLimiter,
  type RateLimitConfig,
} from '../../src/rate-limit';
import type { MemorySource } from '../../src/source';
import { memoryRelay } from './helpers';

const ruleset: Ruleset = {
  env: 'production',
  version: 1,
  flags: {
    banner: {
      key: 'banner',
      kind: 'boolean',
      salt: 's',
      clientSideAvailable: true,
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

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('token bucket', () => {
  it('allows the burst, then refills at the configured rate and reports when to retry', () => {
    const c = clock();
    const limiter = new TokenBucketLimiter({ ratePerSecond: 2, burst: 3 }, 100, c.now);
    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, true]);
    const denied = limiter.take('a');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(500);
    c.advance(499);
    expect(limiter.take('a').allowed).toBe(false);
    c.advance(1);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('b').allowed).toBe(true);
    c.advance(10_000);
    expect(limiter.peek('a').remaining).toBe(3);
  });

  it('charges a cost and computes the wait for the missing tokens', () => {
    const c = clock();
    const limiter = new TokenBucketLimiter({ ratePerSecond: 100, burst: 1000 }, 100, c.now);
    expect(limiter.take('k', 900).allowed).toBe(true);
    const denied = limiter.take('k', 300);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(2000);
    expect(limiter.take('k', 100).allowed).toBe(true);
  });

  it('peek does not consume and unknown ids are allowed', () => {
    const limiter = new TokenBucketLimiter({ ratePerSecond: 1, burst: 1 });
    expect(limiter.peek('x').allowed).toBe(true);
    expect(limiter.size).toBe(0);
    limiter.take('x');
    expect(limiter.peek('x').allowed).toBe(false);
    expect(limiter.peek('x').allowed).toBe(false);
  });

  it('bounds memory: sweeps idle buckets and evicts the least recently used', () => {
    const c = clock();
    const limiter = new TokenBucketLimiter({ ratePerSecond: 1, burst: 5 }, 3, c.now);
    limiter.take('a');
    limiter.take('b');
    limiter.take('c');
    limiter.take('a');
    limiter.take('d');
    expect(limiter.size).toBe(3);
    expect(limiter.peek('b').remaining).toBe(5);
    c.advance(60_000);
    expect(limiter.sweep()).toBe(3);
    expect(limiter.size).toBe(0);
  });

  it('parses policies and Retry-After seconds', () => {
    expect(parsePolicy('10:50', { ratePerSecond: 1, burst: 1 })).toEqual({ ratePerSecond: 10, burst: 50 });
    expect(parsePolicy('7', { ratePerSecond: 1, burst: 1 })).toEqual({ ratePerSecond: 7, burst: 7 });
    expect(parsePolicy('nope', { ratePerSecond: 1, burst: 2 })).toEqual({ ratePerSecond: 1, burst: 2 });
    expect(parsePolicy(undefined, { ratePerSecond: 1, burst: 2 })).toEqual({ ratePerSecond: 1, burst: 2 });
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1001)).toBe(2);
    expect(retryAfterSeconds(0)).toBe(1);
  });

  it('loads limits from the environment', () => {
    expect(loadRateLimits({})).toEqual(defaultRateLimits);
    const env = loadRateLimits({ RELAY_RATE_LIMIT: 'off', RELAY_RATE_LIMIT_IP: '5:10' });
    expect(env.enabled).toBe(false);
    expect(env.ip).toEqual({ ratePerSecond: 5, burst: 10 });
    expect(loadRelayConfig({ RELAY_TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadRelayConfig({ RELAY_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadRelayConfig({}).trustProxy).toBe(false);
  });
});

describe('relay rate limit policy', () => {
  const config: RateLimitConfig = {
    ...defaultRateLimits,
    ip: { ratePerSecond: 1, burst: 2 },
    clientKey: { ratePerSecond: 1, burst: 3 },
    serverKey: { ratePerSecond: 1, burst: 1 },
    clientEvents: { ratePerSecond: 10, burst: 20 },
  };

  it('limits client keys per IP and per key, server keys only per key', () => {
    const c = clock();
    const limits = new RelayRateLimits(config, c.now);
    expect(limits.request('1.1.1.1', 'cli', 'client').allowed).toBe(true);
    expect(limits.request('1.1.1.1', 'cli', 'client').allowed).toBe(true);
    expect(limits.request('1.1.1.1', 'cli', 'client')).toMatchObject({ allowed: false, scope: 'ip' });
    expect(limits.request('2.2.2.2', 'cli', 'client').allowed).toBe(true);
    expect(limits.request('3.3.3.3', 'cli', 'client')).toMatchObject({ allowed: false, scope: 'key' });
    expect(limits.request('9.9.9.9', 'srv', 'server').allowed).toBe(true);
    expect(limits.request('9.9.9.9', 'srv', 'server')).toMatchObject({ allowed: false, scope: 'key' });
    expect(limits.rejected).toMatchObject({ ip: 1, key: 2 });
  });

  it('meters events per key and rejects batches larger than the burst', () => {
    const limits = new RelayRateLimits(config, clock().now);
    expect(limits.events('cli', 'client', 15)).toMatchObject({ allowed: true });
    expect(limits.events('cli', 'client', 10)).toMatchObject({
      allowed: false,
      scope: 'events',
      retryAfterMs: 500,
    });
    expect(limits.events('cli', 'client', 21)).toBe('too-large');
    expect(limits.events('srv', 'server', 50000)).toMatchObject({ allowed: true });
  });

  it('blocks key lookups from an IP after repeated invalid keys', () => {
    const limits = new RelayRateLimits(
      { ...config, invalidKey: { ratePerSecond: 1, burst: 2 } },
      clock().now,
    );
    expect(limits.beforeKeyLookup('6.6.6.6').allowed).toBe(true);
    limits.invalidKeyUsed('6.6.6.6');
    limits.invalidKeyUsed('6.6.6.6');
    expect(limits.beforeKeyLookup('6.6.6.6')).toMatchObject({ allowed: false, scope: 'invalid-key' });
    expect(limits.beforeKeyLookup('7.7.7.7').allowed).toBe(true);
  });

  it('allows everything when disabled', () => {
    const limits = new RelayRateLimits({ ...config, enabled: false });
    for (let i = 0; i < 10; i++) expect(limits.request('1.1.1.1', 'cli', 'client').allowed).toBe(true);
    expect(limits.events('cli', 'client', 10_000)).toMatchObject({ allowed: true });
  });
});

describe('relay HTTP rate limiting', () => {
  let relay: RunningRelay;
  let source: MemorySource;
  const base = loadRelayConfig({}).rateLimit;

  beforeAll(async () => {
    ({ relay, source } = await memoryRelay(15000, {
      trustProxy: true,
      rateLimit: {
        ...base,
        ip: { ratePerSecond: 1, burst: 3 },
        clientKey: { ratePerSecond: 1, burst: 5 },
        serverKey: { ratePerSecond: 1, burst: 2 },
        invalidKey: { ratePerSecond: 0.5, burst: 2 },
        clientEvents: { ratePerSecond: 1, burst: 4 },
      },
    }));
    for (const [key, kind] of [
      ['cli-a', 'client'],
      ['cli-b', 'client'],
      ['cli-c', 'client'],
      ['srv-a', 'server'],
    ] as const)
      source.keys.set(key, { envId: 'env', kind });
    source.snapshots.set('env', { envId: 'env', envKey: 'production', version: 1, ruleset });
  });

  afterAll(async () => {
    await relay.close();
  });

  const evaluate = (key: string, ip: string) =>
    fetch(`${relay.url}/sdk/v1/evaluate`, {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ context: { kind: 'user', key: 'u' } }),
    });

  it('answers 429 with Retry-After per IP on client evaluate and exposes the header to browsers', async () => {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await evaluate('cli-a', '10.0.0.1')).status);
    expect(statuses).toEqual([200, 200, 200]);
    const limited = await evaluate('cli-a', '10.0.0.1');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get('access-control-expose-headers')).toContain('retry-after');
    expect(await limited.json()).toEqual({ error: 'rate limit exceeded', scope: 'ip' });
    expect((await evaluate('cli-a', '10.0.0.2')).status).toBe(200);
  });

  it('limits a client key across many IPs', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await evaluate('cli-b', `10.1.0.${i}`)).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  it('limits event batches by request and by event count per key', async () => {
    const send = (count: number, ip: string) =>
      fetch(`${relay.url}/sdk/v1/events?key=cli-c`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-forwarded-for': ip },
        body: JSON.stringify({
          events: Array.from({ length: count }, (_, i) => ({
            kind: 'custom',
            key: 'buy',
            contextKey: `u${i}`,
            ts: 1,
          })),
        }),
      });
    expect((await send(3, '10.2.0.1')).status).toBe(202);
    const quota = await send(3, '10.2.0.2');
    expect(quota.status).toBe(429);
    expect(await quota.json()).toMatchObject({ scope: 'events' });
    expect(Number(quota.headers.get('retry-after'))).toBeGreaterThanOrEqual(2);
    expect((await send(5, '10.2.0.3')).status).toBe(413);
    const metrics = await (await fetch(`${relay.url}/metrics`)).text();
    expect(metrics).toMatch(/relay_rate_limited_total\{scope="events"\} [1-9]/);
  });

  it('limits server keys on ruleset polling and stream connects', async () => {
    const get = () => fetch(`${relay.url}/sdk/v1/ruleset`, { headers: { authorization: 'srv-a' } });
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    const limited = await get();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    const stream = await fetch(`${relay.url}/sdk/v1/stream`, { headers: { authorization: 'srv-a' } });
    expect(stream.status).toBe(429);
  });

  it('stops key lookups from an IP that keeps sending invalid keys', async () => {
    const bad = (key: string) =>
      fetch(`${relay.url}/sdk/v1/ruleset`, {
        headers: { authorization: key, 'x-forwarded-for': '10.3.0.1' },
      });
    expect((await bad('guess-1')).status).toBe(401);
    expect((await bad('guess-2')).status).toBe(401);
    const blocked = await bad('guess-3');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(
      (
        await fetch(`${relay.url}/sdk/v1/ruleset`, {
          headers: { authorization: 'nope', 'x-forwarded-for': '10.3.0.2' },
        })
      ).status,
    ).toBe(401);
  });

  it('rejects oversized evaluate bodies', async () => {
    const response = await fetch(`${relay.url}/sdk/v1/evaluate`, {
      method: 'POST',
      headers: { authorization: 'cli-a', 'content-type': 'application/json', 'x-forwarded-for': '10.4.0.1' },
      body: JSON.stringify({ context: { kind: 'user', key: 'u', blob: 'x'.repeat(70 * 1024) } }),
    });
    expect(response.status).toBe(413);
  });
});

describe('client IP behind a proxy', () => {
  it('trusts only the configured number of proxy hops', async () => {
    const base = loadRelayConfig({}).rateLimit;
    const { relay, source } = await memoryRelay(15000, {
      trustProxy: 1,
      rateLimit: { ...base, ip: { ratePerSecond: 0.1, burst: 1 } },
    });
    try {
      source.keys.set('cli-proxy', { envId: 'env', kind: 'client' });
      source.snapshots.set('env', { envId: 'env', envKey: 'production', version: 1, ruleset });
      const evaluate = (forwarded: string) =>
        fetch(`${relay.url}/sdk/v1/evaluate`, {
          method: 'POST',
          headers: {
            authorization: 'cli-proxy',
            'content-type': 'application/json',
            'x-forwarded-for': forwarded,
          },
          body: JSON.stringify({ context: { kind: 'user', key: 'u' } }),
        });
      expect((await evaluate('9.9.9.1, 203.0.113.7')).status).toBe(200);
      expect((await evaluate('9.9.9.2, 203.0.113.7')).status).toBe(429);
      expect((await evaluate('9.9.9.1, 203.0.113.8')).status).toBe(200);
    } finally {
      await relay.close();
    }
  });
});
