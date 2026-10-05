import { describe, expect, it } from 'vitest';
import { backoffDelay, eventContextKey, LruDedupe, SseParser, type SseMessage } from '../src';
import { EventProcessor } from '../src/events';
import { silentLogger } from '../src/logger';

describe('SseParser', () => {
  it('parses events split across chunks, multi-line data, comments and CRLF', () => {
    const messages: SseMessage[] = [];
    const parser = new SseParser((m) => messages.push(m));
    parser.push('event: put\r\ndata: {"a"');
    parser.push(':1}\r\n\r\n:heartbeat\n\n');
    parser.push('data: line1\ndata: line2\nid: 7\n\n');
    parser.push('event: patch\ndata:{"b":2}\n\n');
    expect(messages).toEqual([
      { event: 'put', data: '{"a":1}' },
      { event: 'message', data: 'line1\nline2', id: '7' },
      { event: 'patch', data: '{"b":2}', id: '7' },
    ]);
  });
});

describe('backoff', () => {
  it('grows exponentially from 1s to 30s with jitter in [base/2, base]', () => {
    expect(backoffDelay(1, 1000, 30000, () => 1)).toBe(1000);
    expect(backoffDelay(1, 1000, 30000, () => 0)).toBe(500);
    expect(backoffDelay(3, 1000, 30000, () => 1)).toBe(4000);
    expect(backoffDelay(20, 1000, 30000, () => 1)).toBe(30000);
    expect(backoffDelay(20, 1000, 30000, () => 0)).toBe(15000);
  });
});

describe('LruDedupe', () => {
  it('dedupes within the ttl and evicts least recently used', () => {
    const lru = new LruDedupe(2, 1000);
    expect(lru.seen('a', 0)).toBe(false);
    expect(lru.seen('a', 10)).toBe(true);
    expect(lru.seen('b', 20)).toBe(false);
    expect(lru.seen('a', 30)).toBe(true);
    expect(lru.seen('c', 40)).toBe(false);
    expect(lru.seen('b', 50)).toBe(false);
    expect(lru.seen('a', 2000)).toBe(false);
    expect(lru.size).toBeLessThanOrEqual(2);
  });
});

describe('EventProcessor', () => {
  it('drops oldest events beyond capacity and counts them', async () => {
    const sent: unknown[] = [];
    const processor = new EventProcessor({
      url: 'http://x/events',
      headers: {},
      fetch: (async (_url: string, init: RequestInit) => {
        sent.push(...(JSON.parse(String(init.body)) as { events: unknown[] }).events);
        return new Response('{}', { status: 202 });
      }) as typeof fetch,
      capacity: 3,
      flushIntervalMs: 100000,
      dedupTtlMs: 3600000,
      dedupCapacity: 100,
      timeoutMs: 1000,
      logger: silentLogger,
    });
    for (let i = 0; i < 5; i++) processor.custom(`e${i}`, 'u');
    processor.exposure({
      flagKey: 'f',
      variationId: 'on',
      contextKey: 'u',
      contextKind: 'user',
      inExperiment: false,
      reason: 'FALLTHROUGH',
      attributes: [],
    });
    processor.exposure({
      flagKey: 'f',
      variationId: 'on',
      contextKey: 'u',
      contextKind: 'user',
      inExperiment: false,
      reason: 'FALLTHROUGH',
      attributes: [],
    });
    expect(processor.dropped).toBe(3);
    expect(processor.deduped).toBe(1);
    await processor.flush();
    const kinds = sent.map((e) => (e as { kind: string }).kind);
    expect(kinds).toEqual(['custom', 'custom', 'exposure', 'summary']);
    const summary = sent[3] as { counters: Array<{ count: number }> };
    expect(summary.counters[0]!.count).toBe(2);
    await processor.flush();
    expect(sent).toHaveLength(4);
  });

  it('retries once and then gives up without throwing', async () => {
    let calls = 0;
    const processor = new EventProcessor({
      url: 'http://x/events',
      headers: {},
      fetch: (async () => {
        calls++;
        throw new Error('network down');
      }) as typeof fetch,
      capacity: 10,
      flushIntervalMs: 100000,
      dedupTtlMs: 1000,
      dedupCapacity: 10,
      timeoutMs: 1000,
      logger: silentLogger,
      retryDelayMs: 1,
    });
    processor.custom('purchase', 'u', 10);
    await processor.flush();
    expect(calls).toBe(2);
    expect(processor.failedFlushes).toBe(1);
  });
});

describe('eventContextKey', () => {
  it('prefers the user key and falls back to a canonical key', () => {
    expect(eventContextKey({ kind: 'user', key: 'u1' })).toEqual({ key: 'u1', kind: 'user' });
    expect(eventContextKey({ kind: 'multi', user: { key: 'u1' }, organization: { key: 'o' } })).toEqual({
      key: 'u1',
      kind: 'user',
    });
    expect(eventContextKey({ kind: 'organization', key: 'acme' })).toEqual({
      key: 'acme',
      kind: 'organization',
    });
    expect(eventContextKey({ kind: 'multi', device: { key: 'd' }, organization: { key: 'o' } }).kind).toBe(
      'multi',
    );
  });
});
