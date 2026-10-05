import { afterEach, describe, expect, inject, it } from 'vitest';
import { createClient, contextKey, type WebClient } from '../src';

const relayUrl = inject('relayUrl');
const controlUrl = inject('controlUrl');
const clients: WebClient[] = [];

function make(options: Partial<Parameters<typeof createClient>[0]> = {}): WebClient {
  const client = createClient({
    clientKey: 'cli-live',
    baseUrl: relayUrl,
    context: { kind: 'user', key: `visitor-${Math.random()}` },
    flushIntervalMs: 60000,
    ...options,
  });
  clients.push(client);
  return client;
}

async function until(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await fetch(`${controlUrl}/live/a`, { method: 'POST' });
});

describe('sdk-web in Chromium', () => {
  it('receives streamed changes without reload and emits change events', async () => {
    const client = make();
    await client.ready();
    expect(client.variation('banner', 'x')).toBe('Welcome');
    expect(client.allFlags()).toEqual({ banner: 'Welcome' });
    const changes: Array<Record<string, { current: unknown; previous: unknown }>> = [];
    client.on('change', (c) => changes.push(c));
    const started = performance.now();
    await fetch(`${controlUrl}/live/b`, { method: 'POST' });
    await until(() => client.variation<string>('banner', 'x') === 'Sale');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(changes[0]).toEqual({ banner: { current: 'Sale', previous: 'Welcome' } });
  });

  it('never receives server-only flags or rules', async () => {
    const client = make();
    await client.ready();
    expect(Object.keys(client.allFlags())).toEqual(['banner']);
    expect(client.variationDetail('server-only', false).reason).toEqual({
      kind: 'ERROR',
      errorKind: 'FLAG_NOT_FOUND',
    });
  });

  it('re-evaluates on identify', async () => {
    const client = make();
    await client.ready();
    await client.identify({ kind: 'user', key: 'p1', plan: 'pro' });
    expect(client.variation('banner', 'x')).toBe('Sale');
  });

  it('uses bootstrap values immediately and the localStorage cache on the next visit', async () => {
    const context = { kind: 'user', key: `cache-${Math.random()}` };
    const boot = make({
      context,
      bootstrap: { flags: { banner: { value: 'From SSR', variationId: 'b' } } },
      baseUrl: 'http://127.0.0.1:9',
    });
    expect(boot.variation('banner', 'x')).toBe('From SSR');
    expect((await boot.waitForInitialization({ timeoutMs: 50 })).initialized).toBe(true);
    const first = make({ context });
    await first.ready();
    await first.close();
    const offline = make({ context, baseUrl: 'http://127.0.0.1:9', sendEvents: false });
    expect(offline.variation('banner', 'x')).toBe('Welcome');
  });

  it('returns defaults without throwing when the relay is unreachable', async () => {
    const client = make({
      baseUrl: 'http://127.0.0.1:9',
      storage: null,
      streamInitialRetryMs: 20,
      streamMaxRetryMs: 50,
    });
    const status = await client.waitForInitialization({ timeoutMs: 200 });
    expect(status.initialized).toBe(false);
    expect(client.variation('banner', 'fallback')).toBe('fallback');
    expect(client.variationDetail('banner', 'fallback').reason).toEqual({
      kind: 'ERROR',
      errorKind: 'CLIENT_NOT_READY',
    });
    expect(() => client.track('click')).not.toThrow();
  });

  it('counts exposure when variation() is called, not on load, and sends it with sendBeacon when the page is hidden', async () => {
    const context = { kind: 'user', key: `beacon-${Math.random()}` };
    const client = make({ context });
    await client.ready();
    const before = (await (await fetch(`${controlUrl}/events`)).json()) as Array<{
      kind: string;
      contextKey?: string;
    }>;
    expect(before.filter((e) => e.contextKey === context.key)).toHaveLength(0);
    client.variation('banner', 'x');
    client.variation('banner', 'x');
    client.track('purchase', { value: 12.5 });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    let events: Array<{
      kind: string;
      contextKey?: string;
      inExperiment?: boolean;
      counters?: Array<{ count: number }>;
    }> = [];
    await until(() => {
      void fetch(`${controlUrl}/events`).then(async (r) => (events = await r.json()));
      return events.some((e) => e.kind === 'custom' && e.contextKey === context.key);
    });
    const mine = events.filter((e) => e.contextKey === context.key);
    expect(mine.filter((e) => e.kind === 'exposure')).toHaveLength(1);
    expect(mine.find((e) => e.kind === 'exposure')!.inExperiment).toBe(true);
    expect(events.some((e) => e.kind === 'summary' && e.counters?.some((c) => c.count === 2))).toBe(true);
  });

  it('derives the same event context key as the server SDK', () => {
    expect(contextKey({ kind: 'user', key: 'u1' })).toBe('u1');
    expect(contextKey({ kind: 'multi', user: { key: 'u1' }, organization: { key: 'o' } })).toBe('u1');
    expect(contextKey({ kind: 'multi', organization: { key: 'o' }, device: { key: 'd 1' } })).toBe(
      'device:d%201:organization:o',
    );
  });
});
