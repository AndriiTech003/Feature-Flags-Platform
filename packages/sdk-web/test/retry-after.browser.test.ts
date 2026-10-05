import { afterEach, describe, expect, inject, it } from 'vitest';
import { createClient, retryAfterMs, type WebClient } from '../src';

const limitedRelayUrl = inject('limitedRelayUrl');
const controlUrl = inject('controlUrl');
const clients: WebClient[] = [];

async function freshKey(): Promise<string> {
  const key = `cli-limit-${Math.random().toString(36).slice(2, 10)}`;
  await fetch(`${controlUrl}/limited/keys/${key}`, { method: 'POST' });
  return key;
}

async function exhaust(key: string): Promise<void> {
  const response = await fetch(`${limitedRelayUrl}/sdk/v1/evaluate`, {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({ context: { kind: 'user', key: 'warmup' } }),
  });
  expect(response.status).toBe(200);
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('sdk-web honours Retry-After', () => {
  it('parses Retry-After seconds and dates and ignores other statuses', () => {
    const now = Date.parse('2026-10-05T10:00:00Z');
    const response = (status: number, value?: string) => ({
      status,
      headers: new Headers(value === undefined ? {} : { 'retry-after': value }),
    });
    expect(retryAfterMs(response(429, '2'), now)).toBe(2000);
    expect(retryAfterMs(response(503, 'Mon, 05 Oct 2026 10:00:03 GMT'), now)).toBe(3000);
    expect(retryAfterMs(response(429), now)).toBe(1000);
    expect(retryAfterMs(response(429, '86400'), now)).toBe(600000);
    expect(retryAfterMs(response(500, '5'), now)).toBe(0);
    expect(retryAfterMs(response(200), now)).toBe(0);
  });

  it('a throttled stream connect waits for Retry-After instead of its own fast backoff', async () => {
    const key = await freshKey();
    await exhaust(key);
    const started = performance.now();
    const client = createClient({
      clientKey: key,
      baseUrl: limitedRelayUrl,
      context: { kind: 'user', key: 'throttled-stream' },
      sendEvents: false,
      streamInitialRetryMs: 10,
      streamMaxRetryMs: 20,
    });
    clients.push(client);
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.message));
    await client.ready();
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    expect(errors).toEqual(['stream failed: 429']);
    expect(client.variation('banner', 'x')).toBe('Welcome');
  });

  it('keeps throttled events and sends them once the relay allows it', async () => {
    const key = await freshKey();
    const context = { kind: 'user', key: `throttled-events-${Math.random()}` };
    const client = createClient({
      clientKey: key,
      baseUrl: limitedRelayUrl,
      context,
      stream: false,
      flushIntervalMs: 50,
    });
    clients.push(client);
    await client.ready();
    client.track('purchase', { value: 3 });
    const started = performance.now();
    await client.flush();
    let events: Array<{ kind: string; contextKey?: string }> = [];
    const mine = () => events.filter((e) => e.kind === 'custom' && e.contextKey === context.key);
    await until(async () => {
      events = await (await fetch(`${controlUrl}/limited/events`)).json();
      return mine().length > 0;
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    await new Promise((r) => setTimeout(r, 200));
    events = await (await fetch(`${controlUrl}/limited/events`)).json();
    expect(mine()).toHaveLength(1);
    const metrics = await (await fetch(`${limitedRelayUrl}/metrics`)).text();
    expect(metrics).toMatch(/relay_rate_limited_total\{scope="key"\} [1-9]/);
  });
});
