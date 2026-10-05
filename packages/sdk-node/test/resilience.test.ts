import { afterEach, describe, expect, it } from 'vitest';
import { init, MemoryPersistentStore, silentLogger, type FlagsClient } from '../src';
import { FakeRelay, sampleRuleset, waitFor } from './fake-relay';

const pro = { kind: 'user', key: 'u1', plan: 'pro' };
const clients: FlagsClient[] = [];
const relays: FakeRelay[] = [];

function client(baseUrl: string, extra: Record<string, unknown> = {}): FlagsClient {
  const c = init({
    sdkKey: 'srv-test',
    baseUrl,
    logger: silentLogger,
    streamInitialRetryMs: 50,
    streamMaxRetryMs: 200,
    pollIntervalMs: 100,
    events: { flushIntervalMs: 50 },
    ...extra,
  });
  clients.push(c);
  return c;
}

async function relay(): Promise<FakeRelay> {
  const r = new FakeRelay(sampleRuleset());
  relays.push(r);
  await r.start();
  return r;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(relays.splice(0).map((r) => r.stop()));
});

describe('sdk-node resilience', () => {
  it('relay down at start: returns defaults without throwing, then recovers when the relay comes up', async () => {
    const r = new FakeRelay(sampleRuleset());
    relays.push(r);
    await r.start();
    const port = r.port;
    await r.stop();
    const c = client(`http://127.0.0.1:${port}`);
    const status = await c.waitForInitialization({ timeoutMs: 200 });
    expect(status.initialized).toBe(false);
    expect(status.timedOut).toBe(true);
    expect(c.boolVariation('new-checkout', pro, false)).toBe(false);
    expect(c.boolVariationDetail('new-checkout', pro, false).reason).toEqual({
      kind: 'ERROR',
      errorKind: 'CLIENT_NOT_READY',
    });
    await r.start(port);
    await waitFor(() => c.initialized(), 5000);
    expect(c.boolVariation('new-checkout', pro, false)).toBe(true);
  });

  it('relay dies mid-stream: keeps last known values, reports stale, and picks up changes after restart', async () => {
    const r = await relay();
    const c = client(r.url);
    const stale: string[] = [];
    c.on('stale', (e) => stale.push(e.reason));
    expect((await c.waitForInitialization({ timeoutMs: 2000 })).initialized).toBe(true);
    expect(c.boolVariation('new-checkout', pro, false)).toBe(true);
    const port = r.port;
    await r.stop();
    await waitFor(() => stale.length > 0);
    expect(c.boolVariation('new-checkout', pro, false)).toBe(true);
    r.patchFlag('new-checkout', (flag) => {
      flag.config.on = false;
    });
    await r.start(port);
    await waitFor(() => c.boolVariation('new-checkout', pro, true) === false, 5000);
    expect(c.status().reconnects).toBeGreaterThan(0);
  });

  it('broken stream: malformed put is reported, defaults are served, and the client recovers via reconnect or polling', async () => {
    const r = await relay();
    r.mode = 'broken';
    const errors: Error[] = [];
    const c = client(r.url, { pollIntervalMs: 60000 });
    c.on('error', (e) => errors.push(e));
    await waitFor(() => errors.length > 0);
    expect(c.stringVariation('banner-text', pro, 'default')).toMatch(/default|Welcome|Sale/);
    r.mode = 'normal';
    await waitFor(() => c.initialized(), 5000);
    expect(['Welcome', 'Sale']).toContain(c.stringVariation('banner-text', pro, 'default'));
  });

  it('slow relay: initialization times out with defaults, then completes', async () => {
    const r = await relay();
    r.delayMs = 600;
    const c = client(r.url);
    const started = Date.now();
    const status = await c.waitForInitialization({ timeoutMs: 100 });
    expect(Date.now() - started).toBeLessThan(400);
    expect(status.initialized).toBe(false);
    expect(c.boolVariation('new-checkout', pro, false)).toBe(false);
    await waitFor(() => c.initialized(), 5000);
    expect(c.boolVariation('new-checkout', pro, false)).toBe(true);
  });

  it('reconnects when no heartbeat arrives within the timeout', async () => {
    const r = await relay();
    const c = client(r.url, { heartbeatTimeoutMs: 150 });
    await c.waitForInitialization({ timeoutMs: 2000 });
    r.mode = 'silent';
    await waitFor(() => r.streamConnections >= 3, 5000);
    expect(c.status().reconnects).toBeGreaterThanOrEqual(2);
  });

  it('applies streamed patches and emits update events', async () => {
    const r = await relay();
    const c = client(r.url);
    await c.waitForInitialization({ timeoutMs: 2000 });
    const updates: string[] = [];
    c.on('update', (u) => updates.push(u.key));
    r.patchFlag('new-checkout', (flag) => {
      flag.config.rules = [];
      flag.config.fallthrough = { variation: 'on' };
    });
    await waitFor(() => updates.includes('new-checkout'));
    expect(c.boolVariation('new-checkout', { kind: 'user', key: 'free' }, false)).toBe(true);
  });

  it('polling mode uses ETag and receives 304 when nothing changed', async () => {
    const r = await relay();
    const c = client(r.url, { stream: false, pollIntervalMs: 50 });
    await c.waitForInitialization({ timeoutMs: 2000 });
    await waitFor(() => r.notModified >= 2);
    expect(r.streamConnections).toBe(0);
    r.patchFlag('new-checkout', (flag) => {
      flag.config.on = false;
    });
    await waitFor(() => c.boolVariation('new-checkout', pro, true) === false);
  });

  it('falls back to the persistent store when the relay is unreachable', async () => {
    const store = new MemoryPersistentStore();
    const r = await relay();
    const first = client(r.url, { persistentStore: store });
    await first.waitForInitialization({ timeoutMs: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await first.close();
    const port = r.port;
    await r.stop();
    const second = client(`http://127.0.0.1:${port}`, { persistentStore: store });
    await waitFor(() => second.status().source === 'persistent');
    expect(second.boolVariation('new-checkout', pro, false)).toBe(true);
  });

  it('sends deduplicated exposures, custom events and summaries; close flushes', async () => {
    const r = await relay();
    const c = client(r.url, { events: { flushIntervalMs: 100000 } });
    await c.waitForInitialization({ timeoutMs: 2000 });
    for (let i = 0; i < 100; i++) c.stringVariation('banner-text', { kind: 'user', key: 'visitor-1' }, 'x');
    c.track('purchase', { kind: 'user', key: 'visitor-1' }, { value: 49.9 });
    await c.close();
    const kinds = r.events.map((e) => (e as { kind: string }).kind);
    expect(kinds.filter((k) => k === 'exposure')).toHaveLength(1);
    expect(kinds).toContain('custom');
    expect(kinds).toContain('summary');
    expect(kinds).toContain('diagnostic');
    const exposure = r.events.find((e) => (e as { kind: string }).kind === 'exposure') as {
      inExperiment: boolean;
      contextKey: string;
    };
    expect(exposure.inExperiment).toBe(true);
    expect(exposure.contextKey).toBe('visitor-1');
    const summary = r.events.find((e) => (e as { kind: string }).kind === 'summary') as {
      counters: Array<{ count: number }>;
    };
    expect(summary.counters[0]!.count).toBe(100);
  });

  it('never throws to the application for any input', async () => {
    const c = init({ sdkKey: '', logger: silentLogger });
    clients.push(c);
    const garbage: unknown[] = [null, undefined, 42, 'x', {}, [], { kind: 'multi' }, { key: 5 }];
    for (const ctx of garbage) {
      expect(() => c.boolVariation('x', ctx as never, true)).not.toThrow();
      expect(() => c.variationDetail(null as never, ctx as never, 1)).not.toThrow();
      expect(() => c.allFlagsState(ctx as never)).not.toThrow();
      expect(() => c.track(null as never, ctx as never)).not.toThrow();
    }
    expect(c.boolVariation('x', { kind: 'user', key: 'u' }, true)).toBe(true);
    await expect(c.flush()).resolves.toBeUndefined();
    expect(() => init({ sdkKey: '', throwOnInvalidConfig: true, logger: silentLogger })).toThrow();
  });

  it('allFlagsState produces a bootstrap payload for the web SDK', async () => {
    const c = init({ sdkKey: 'srv', offline: true, bootstrap: sampleRuleset(), logger: silentLogger });
    clients.push(c);
    const state = c.allFlagsState(pro, { clientSideOnly: true, withReasons: true });
    expect(state.valid).toBe(true);
    expect(Object.keys(state.flags)).toEqual(['new-checkout']);
    expect(JSON.parse(JSON.stringify(state))).toEqual({
      valid: true,
      flags: {
        'new-checkout': {
          value: true,
          variationId: 'on',
          version: 1,
          reason: { kind: 'RULE_MATCH', ruleIndex: 0, ruleId: 'pro' },
        },
      },
    });
  });
});

describe('sdk-node honours Retry-After', () => {
  it('waits for Retry-After before reconnecting the stream or polling', async () => {
    const r = await relay();
    r.throttle.stream = 1;
    r.throttle.ruleset = 1;
    const c = client(r.url, { pollIntervalMs: 50 });
    await waitFor(() => c.initialized(), 5000);
    const first429 = r.log.find((e) => e.status === 429)!;
    const throttled = r.log.filter((e) => e.status === 429);
    const afterThrottle = r.log.filter((e) => e.status === 200 && e.path !== '/sdk/v1/events');
    expect(throttled.length).toBeGreaterThanOrEqual(1);
    expect(afterThrottle.length).toBeGreaterThan(0);
    for (const request of afterThrottle) expect(request.at - first429.at).toBeGreaterThanOrEqual(950);
    expect(c.status().throttled).toBeGreaterThanOrEqual(1);
    expect(c.boolVariation('new-checkout', pro, false)).toBe(true);
  });

  it('keeps throttled events and resends them only after Retry-After', async () => {
    const r = await relay();
    r.throttle.events = 1;
    r.retryAfter = '1';
    const c = client(r.url, { diagnostics: { enabled: false } });
    await c.waitForInitialization({ timeoutMs: 2000 });
    c.track('purchase', pro, { value: 42 });
    await waitFor(() => r.log.some((e) => e.path === '/sdk/v1/events' && e.status === 429), 3000);
    const throttledAt = r.log.find((e) => e.path === '/sdk/v1/events' && e.status === 429)!.at;
    await waitFor(() => r.events.some((e) => (e as { kind: string; key?: string }).key === 'purchase'), 5000);
    const accepted = r.log.find((e) => e.path === '/sdk/v1/events' && e.status === 200)!;
    expect(accepted.at - throttledAt).toBeGreaterThanOrEqual(950);
    expect(c.status().droppedEvents).toBe(0);
  });

  it('accepts an HTTP-date Retry-After and caps absurd values', async () => {
    const { parseRetryAfter, MAX_RETRY_AFTER_MS } = await import('../src');
    const now = Date.parse('2026-10-05T10:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter('0.5', now)).toBe(500);
    expect(parseRetryAfter('Mon, 05 Oct 2026 10:00:07 GMT', now)).toBe(7000);
    expect(parseRetryAfter('Mon, 05 Oct 2026 09:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('999999', now)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});
