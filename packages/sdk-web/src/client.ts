import type {
  Change,
  Context,
  Detail,
  ExpectedKind,
  FlagValue,
  FlagValues,
  WebClientEvents,
  WebClientOptions,
  WebFlagTypes,
} from './types';

type Listener<T> = (payload: T) => void;
type KnownKey = keyof WebFlagTypes & string;

const NOT_READY = { kind: 'ERROR', errorKind: 'CLIENT_NOT_READY' };
const VERSION = '0.1.0';

function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = (Math.imul(h, 33) ^ input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function nested(ctx: Context): Array<[string, Context]> {
  if (ctx.kind !== 'multi') return [[(ctx.kind as string) || 'user', ctx]];
  return Object.keys(ctx)
    .filter((k) => k !== 'kind')
    .sort()
    .map((k) => [k, ctx[k] as Context]);
}

export function contextKey(ctx: Context): string {
  const parts = nested(ctx);
  const user = parts.find(([k]) => k === 'user');
  if (user) return String(user[1].key);
  if (parts.length === 1) return String(parts[0]![1].key);
  return parts.map(([k, c]) => `${k}:${encodeURIComponent(String(c.key))}`).join(':');
}

function encode(ctx: Context): string {
  const bytes = new TextEncoder().encode(JSON.stringify(ctx));
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function retryAfterMs(response: Pick<Response, 'status' | 'headers'>, now = Date.now()): number {
  if (response.status !== 429 && response.status !== 503) return 0;
  const raw = response.headers.get('retry-after') ?? '';
  const ms = /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) * 1000 : Date.parse(raw) - now;
  return Math.min(600000, Math.max(1, Math.ceil(ms) || 1000));
}

function kindOk(value: unknown, kind?: ExpectedKind): boolean {
  if (!kind || kind === 'json') return true;
  return kind === 'number' ? typeof value === 'number' : typeof value === kind;
}

export class WebClient {
  private values: FlagValues = {};
  private context: Context;
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly listeners: { [K in keyof WebClientEvents]?: Set<Listener<WebClientEvents[K]>> } = {};
  private queue: unknown[] = [];
  private counters: Record<string, { flagKey: string; variationId: string | null; count: number }> = {};
  private summaryStart = Date.now();
  private seen = new Set<string>();
  private controller: AbortController | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private attempt = 0;
  private until = 0;
  private eventsUntil = 0;
  private hasServerValues = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private closed = false;
  private generation = 0;
  private readonly onHide = () => {
    if (document.visibilityState === 'hidden') this.beacon();
  };

  constructor(private readonly options: WebClientOptions) {
    this.context = options.context;
    this.base = (options.baseUrl ?? 'https://relay.flags.ashamrai.dev').replace(/\/+$/, '');
    this.fetcher = options.fetch ?? fetch.bind(globalThis);
    this.readyPromise = new Promise((resolve) => (this.resolveReady = resolve));
    const boot = options.bootstrap;
    const bootValues = boot
      ? ((boot as { flags?: FlagValues }).flags ?? (boot as FlagValues))
      : this.cached();
    if (bootValues) {
      this.values = bootValues;
      if (boot) this.markReady();
    }
    if (options.sendEvents !== false) {
      this.every(options.flushIntervalMs ?? 5000, () => void this.flush());
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onHide);
    }
    this.connect();
  }

  private every(ms: number, fn: () => void): void {
    this.timers.push(setInterval(fn, ms));
  }

  private storageKey(): string {
    return `ffp:${hash(this.options.clientKey)}:${hash(JSON.stringify(this.context))}`;
  }

  private storage() {
    if (this.options.storage !== undefined) return this.options.storage;
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  }

  private cached(): FlagValues | null {
    try {
      const raw = this.storage()?.getItem(this.storageKey());
      return raw ? (JSON.parse(raw) as FlagValues) : null;
    } catch {
      return null;
    }
  }

  private markReady(): void {
    this.resolveReady();
    this.emit('ready', undefined);
  }

  private headers(): Record<string, string> {
    return { authorization: this.options.clientKey, 'content-type': 'application/json' };
  }

  private apply(next: FlagValues, replace: boolean): void {
    const merged: FlagValues = replace ? {} : { ...this.values };
    for (const key in next) {
      if (next[key]) merged[key] = next[key]!;
      else delete merged[key];
    }
    const changes: Record<string, Change> = {};
    let changed = false;
    for (const key of new Set([...Object.keys(this.values), ...Object.keys(merged)])) {
      const before = this.values[key];
      const after = merged[key];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes[key] = { current: after?.value, previous: before?.value };
        changed = true;
      }
    }
    this.values = merged;
    try {
      this.storage()?.setItem(this.storageKey(), JSON.stringify(merged));
    } catch {
      this.options.logger?.warn('flags cache unavailable');
    }
    if (!this.hasServerValues) {
      this.hasServerValues = true;
      this.markReady();
    }
    if (changed) this.emit('change', changes);
  }

  private fail(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.options.logger?.warn(err.message);
    this.emit('error', err);
  }

  private wait(): number {
    return Math.max(0, this.until - Date.now());
  }

  private refused(response: Response, what: string): Error {
    this.until = Math.max(this.until, Date.now() + retryAfterMs(response));
    return new Error(`${what} failed: ${response.status}`);
  }

  private retryDelay(): number {
    const base = Math.min(
      this.options.streamMaxRetryMs ?? 30000,
      (this.options.streamInitialRetryMs ?? 1000) * 2 ** this.attempt++,
    );
    return Math.max(base / 2 + Math.random() * (base / 2), this.wait());
  }

  private connect(): void {
    if (this.closed) return;
    const generation = ++this.generation;
    this.controller?.abort();
    if (this.options.stream === false) {
      void this.evaluate(generation).then(() => {
        if (this.options.pollIntervalMs && generation === this.generation) {
          this.timers.push(
            setTimeout(() => this.connect(), Math.max(this.options.pollIntervalMs, this.wait())),
          );
        }
      });
      return;
    }
    void this.stream(generation);
  }

  private async evaluate(generation: number): Promise<boolean> {
    if (this.wait() > 0) return false;
    try {
      const response = await this.fetcher(`${this.base}/sdk/v1/evaluate`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ context: this.context, withReasons: this.options.withReasons }),
      });
      if (!response.ok) throw this.refused(response, 'evaluate');
      const body = (await response.json()) as { flags: FlagValues };
      if (generation === this.generation) this.apply(body.flags, true);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  private async stream(generation: number): Promise<void> {
    if (this.wait()) {
      this.timers.push(setTimeout(() => generation === this.generation && this.connect(), this.wait()));
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(), this.options.heartbeatTimeoutMs ?? 45000);
    };
    try {
      arm();
      const url = `${this.base}/sdk/v1/client-stream?ctx=${encode(this.context)}${this.options.withReasons ? '&reasons=true' : ''}`;
      const response = await this.fetcher(url, {
        headers: { authorization: this.options.clientKey },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw this.refused(response, 'stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: ?(.*)$/m.exec(block)?.[1];
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (!data || generation !== this.generation) continue;
          const payload = JSON.parse(data) as { flags: FlagValues };
          if (event === 'put') {
            this.attempt = 0;
            this.apply(payload.flags, true);
          } else if (event === 'patch') this.apply(payload.flags, false);
        }
      }
      throw new Error('stream closed');
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      this.fail(error);
      if (!this.hasServerValues) await this.evaluate(generation);
      this.timers.push(setTimeout(() => generation === this.generation && this.connect(), this.retryDelay()));
    } finally {
      clearTimeout(watchdog);
    }
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async waitForInitialization(options: { timeoutMs?: number } = {}): Promise<{ initialized: boolean }> {
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), options.timeoutMs ?? 5000),
    );
    return { initialized: await Promise.race([this.readyPromise.then(() => true), timeout]) };
  }

  variation<K extends KnownKey>(key: K, defaultValue: WebFlagTypes[K]): WebFlagTypes[K];
  variation<T>(key: string, defaultValue: T): T;
  variation(key: string, defaultValue: unknown): unknown {
    return this.variationDetail(key, defaultValue).value;
  }

  variationDetail<T>(key: string, defaultValue: T, expectedKind?: ExpectedKind): Detail<T> {
    try {
      const flag: FlagValue | undefined = this.values[key];
      if (!flag) {
        return {
          value: defaultValue,
          variationId: null,
          reason:
            this.hasServerValues || this.options.bootstrap
              ? { kind: 'ERROR', errorKind: 'FLAG_NOT_FOUND' }
              : NOT_READY,
        };
      }
      this.expose(key, flag);
      const reason = flag.reason ?? { kind: 'UNKNOWN' };
      if (flag.variationId === null) return { value: defaultValue, variationId: null, reason };
      const kind =
        expectedKind ??
        (defaultValue === null || defaultValue === undefined || typeof defaultValue === 'object'
          ? undefined
          : (typeof defaultValue as ExpectedKind));
      if (!kindOk(flag.value, kind))
        return { value: defaultValue, variationId: null, reason: { kind: 'ERROR', errorKind: 'WRONG_TYPE' } };
      return { value: flag.value as T, variationId: flag.variationId, reason };
    } catch (error) {
      this.fail(error);
      return { value: defaultValue, variationId: null, reason: { kind: 'ERROR', errorKind: 'EXCEPTION' } };
    }
  }

  getFlag(key: string): FlagValue | undefined {
    return this.values[key];
  }

  allFlags(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key in this.values) out[key] = this.values[key]!.value;
    return out;
  }

  getContext(): Context {
    return this.context;
  }

  async identify(context: Context): Promise<void> {
    this.context = context;
    this.hasServerValues = false;
    this.seen.clear();
    const cached = this.cached();
    if (cached) this.values = cached;
    this.controller?.abort();
    const generation = ++this.generation;
    await this.evaluate(generation);
    if (this.options.stream !== false && !this.closed) void this.stream(generation);
  }

  private expose(key: string, flag: FlagValue): void {
    if (this.options.sendEvents === false) return;
    const id = `${key}:${flag.variationId}`;
    const counter = (this.counters[id] ??= { flagKey: key, variationId: flag.variationId, count: 0 });
    counter.count++;
    const ctxKey = contextKey(this.context);
    const dedupe = `${ctxKey}|${id}`;
    if (this.seen.has(dedupe)) return;
    if (this.seen.size > 1000) this.seen.clear();
    this.seen.add(dedupe);
    this.push({
      kind: 'exposure',
      flagKey: key,
      variationId: flag.variationId,
      contextKey: ctxKey,
      inExperiment: flag.inExperiment === true,
      version: flag.version,
      ts: Date.now(),
    });
  }

  private push(event: unknown): void {
    if (this.queue.length >= 1000) this.queue.shift();
    this.queue.push(event);
  }

  track(key: string, options: { value?: number; data?: unknown } = {}): void {
    if (this.options.sendEvents === false) return;
    this.push({
      kind: 'custom',
      key,
      contextKey: contextKey(this.context),
      value: options.value,
      data: options.data,
      ts: Date.now(),
    });
  }

  private batch(): unknown[] {
    const events = this.queue;
    this.queue = [];
    const counters = Object.values(this.counters);
    if (counters.length) {
      events.push({ kind: 'summary', startTs: this.summaryStart, endTs: Date.now(), counters });
      this.counters = {};
      this.summaryStart = Date.now();
    }
    return events;
  }

  async flush(): Promise<void> {
    if (Date.now() < this.eventsUntil) return;
    const events = this.batch();
    if (!events.length) return;
    try {
      const response = await this.fetcher(`${this.base}/sdk/v1/events`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ events }),
        keepalive: true,
      });
      const wait = retryAfterMs(response);
      if (wait) {
        this.eventsUntil = Date.now() + wait;
        this.queue = events.concat(this.queue).slice(-1000);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private beacon(): void {
    if (Date.now() < this.eventsUntil) return;
    const events = this.batch();
    if (!events.length) return;
    const body = JSON.stringify({ events });
    const url = `${this.base}/sdk/v1/events?key=${encodeURIComponent(this.options.clientKey)}`;
    if (
      typeof navigator !== 'undefined' &&
      navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))
    )
      return;
    void this.fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  }

  on<K extends keyof WebClientEvents>(event: K, listener: Listener<WebClientEvents[K]>): () => void {
    const listeners = this.listeners as Record<string, Set<Listener<WebClientEvents[K]>> | undefined>;
    const set = (listeners[event as string] ??= new Set());
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit<K extends keyof WebClientEvents>(event: K, payload: WebClientEvents[K]): void {
    (this.listeners[event] as Set<Listener<WebClientEvents[K]>> | undefined)?.forEach((listener) => {
      try {
        listener(payload);
      } catch {
        return;
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation++;
    this.controller?.abort();
    this.timers.forEach((t) => clearTimeout(t));
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onHide);
    await this.flush();
  }
}

export function createClient(options: WebClientOptions): WebClient {
  return new WebClient(options);
}

export const SDK_VERSION = VERSION;
