import { RetryGate } from './retry-after';
import type { Logger } from './types';

export interface ExposureInput {
  flagKey: string;
  variationId: string | null;
  contextKey: string;
  contextKind: string;
  inExperiment: boolean;
  version?: number;
  reason: string;
  attributes: string[];
}

export type QueuedEvent =
  | ({ kind: 'exposure'; ts: number } & ExposureInput)
  | { kind: 'custom'; key: string; contextKey: string; value?: number; data?: unknown; ts: number }
  | { kind: 'diagnostic'; ts: number; [field: string]: unknown };

export interface EventProcessorOptions {
  url: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  capacity: number;
  flushIntervalMs: number;
  dedupTtlMs: number;
  dedupCapacity: number;
  timeoutMs: number;
  logger: Logger;
  retryDelayMs?: number;
  gate?: RetryGate;
}

export class LruDedupe {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
  ) {}

  seen(key: string, now = Date.now()): boolean {
    const at = this.entries.get(key);
    if (at !== undefined && now - at < this.ttlMs) {
      this.entries.delete(key);
      this.entries.set(key, at);
      return true;
    }
    if (at !== undefined) this.entries.delete(key);
    this.entries.set(key, now);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return false;
  }

  get size(): number {
    return this.entries.size;
  }
}

export class EventProcessor {
  private queue: QueuedEvent[] = [];
  private readonly dedupe: LruDedupe;
  private counters = new Map<
    string,
    { flagKey: string; variationId: string | null; version?: number; count: number }
  >();
  private summaryStart = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  readonly gate: RetryGate;
  dropped = 0;
  deduped = 0;
  sent = 0;
  failedFlushes = 0;

  constructor(private readonly options: EventProcessorOptions) {
    this.dedupe = new LruDedupe(options.dedupCapacity, options.dedupTtlMs);
    this.gate = options.gate ?? new RetryGate();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get queueSize(): number {
    return this.queue.length;
  }

  private enqueue(event: QueuedEvent): void {
    if (this.queue.length >= this.options.capacity) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(event);
  }

  recordEvaluation(flagKey: string, variationId: string | null, version: number | undefined): void {
    const id = `${flagKey}\u0000${variationId ?? ''}`;
    const counter = this.counters.get(id);
    if (counter) counter.count++;
    else this.counters.set(id, { flagKey, variationId, version, count: 1 });
  }

  exposure(input: ExposureInput): void {
    this.recordEvaluation(input.flagKey, input.variationId, input.version);
    const key = `${input.contextKey}\u0000${input.flagKey}\u0000${input.variationId ?? ''}`;
    if (this.dedupe.seen(key)) {
      this.deduped++;
      return;
    }
    this.enqueue({ kind: 'exposure', ts: Date.now(), ...input });
  }

  custom(key: string, contextKey: string, value?: number, data?: unknown): void {
    const event: QueuedEvent = { kind: 'custom', key, contextKey, ts: Date.now() };
    if (value !== undefined) event.value = value;
    if (data !== undefined) event.data = data;
    this.enqueue(event);
  }

  diagnostic(payload: Record<string, unknown>): void {
    this.enqueue({ kind: 'diagnostic', ts: Date.now(), ...payload });
  }

  private takeBatch(): unknown[] {
    const events: unknown[] = this.queue;
    this.queue = [];
    if (this.counters.size > 0) {
      const now = Date.now();
      events.push({
        kind: 'summary',
        startTs: this.summaryStart,
        endTs: now,
        counters: [...this.counters.values()].map((c) => {
          const counter: Record<string, unknown> = {
            flagKey: c.flagKey,
            variationId: c.variationId,
            count: c.count,
          };
          if (c.version !== undefined) counter.version = c.version;
          return counter;
        }),
      });
      this.counters = new Map();
      this.summaryStart = now;
    }
    return events;
  }

  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
    if (this.gate.remaining() > 0) return;
    const batch = this.takeBatch();
    if (batch.length === 0) return;
    this.flushing = this.send(batch).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private requeue(events: unknown[]): void {
    const room = Math.max(0, this.options.capacity - this.queue.length);
    const kept = events.slice(Math.max(0, events.length - room)) as QueuedEvent[];
    this.dropped += events.length - kept.length;
    this.queue = [...kept, ...this.queue];
  }

  async discardIfThrottled(): Promise<void> {
    while (this.flushing) await this.flushing;
    if (this.gate.remaining() === 0) return;
    const pending = this.takeBatch().length;
    if (pending === 0) return;
    this.dropped += pending;
    this.options.logger.warn(`dropping ${pending} events: the relay asked to retry later`);
  }

  private async send(events: unknown[]): Promise<void> {
    const body = JSON.stringify({ events });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.options.fetch(this.options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.options.headers },
          body,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        const wait = this.gate.note(response);
        if (wait > 0) {
          this.requeue(events);
          this.options.logger.warn(`events throttled with status ${response.status}, retrying in ${wait} ms`);
          return;
        }
        if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
          if (response.ok) this.sent += events.length;
          else this.options.logger.warn(`events rejected with status ${response.status}`);
          return;
        }
        throw new Error(`events endpoint responded with ${response.status}`);
      } catch (error) {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? 1000));
          continue;
        }
        this.failedFlushes++;
        this.options.logger.warn(
          `dropping ${events.length} events after retry: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
