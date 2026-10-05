import {
  canonicalContextKey,
  contextKinds,
  contextOfKind,
  evaluate,
  evaluateAll,
  isValidContext,
  type FlagKind,
} from '@ashamrai/flags-evaluator';
import { Emitter } from './emitter';
import { EventProcessor } from './events';
import { safeLogger } from './logger';
import { RetryGate } from './retry-after';
import { SseClient } from './sse';
import { DataStore, type PatchMessage } from './store';
import type {
  AllFlagsState,
  ClientEvents,
  Context,
  DataSourceKind,
  FlagDetail,
  FlagTypes,
  FlagsOptions,
  InitializationResult,
  KnownFlagKey,
  Logger,
  Ruleset,
} from './types';
import { SDK_NAME, SDK_VERSION } from './version';

const DEFAULT_BASE_URL = 'https://relay.flags.ashamrai.dev';
const PERSIST_KEY = 'ffp:ruleset';

export class ConfigurationError extends Error {}

export function eventContextKey(context: Context): { key: string; kind: string } {
  const user = contextOfKind(context, 'user');
  if (user) return { key: user.key, kind: 'user' };
  const kinds = contextKinds(context);
  if (kinds.length === 1) {
    const only = contextOfKind(context, kinds[0]!);
    if (only) return { key: only.key, kind: kinds[0]! };
  }
  return { key: canonicalContextKey(context), kind: 'multi' };
}

function attributeNames(context: Context): string[] {
  const names: string[] = [];
  for (const kind of contextKinds(context)) {
    const ctx = contextOfKind(context, kind);
    if (!ctx) continue;
    for (const name of Object.keys(ctx)) if (name !== 'kind') names.push(`${kind}:${name}`);
  }
  return names;
}

export class FlagsClient {
  private readonly emitter = new Emitter<ClientEvents>();
  private readonly data = new DataStore();
  private readonly logger: Logger;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly events: EventProcessor | null;
  private sse: SseClient | null = null;
  private readonly dataGate = new RetryGate();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private diagnosticsTimer: ReturnType<typeof setInterval> | null = null;
  private etag: string | null = null;
  private readyResolvers: Array<(result: InitializationResult) => void> = [];
  private source: DataSourceKind = 'none';
  private lastError: string | undefined;
  private closed = false;
  private streamConnected = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly startedAt = Date.now();
  private initDurationMs: number | null = null;
  private readonly instanceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private readonly beforeExit = () => void this.flush();
  private readonly valid: boolean;

  constructor(private readonly options: FlagsOptions) {
    this.logger = safeLogger(options.logger);
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = { authorization: options.sdkKey ?? '', 'x-ffp-sdk': `${SDK_NAME}/${SDK_VERSION}` };
    this.valid = typeof options.sdkKey === 'string' && options.sdkKey.length > 0;
    if (!this.valid) {
      const message = 'sdkKey is required';
      if (options.throwOnInvalidConfig) throw new ConfigurationError(message);
      this.logger.error(message);
    }
    const eventOptions = options.events ?? {};
    this.events =
      eventOptions.enabled === false || options.offline
        ? null
        : new EventProcessor({
            url: `${this.baseUrl}/sdk/v1/events`,
            headers: this.headers,
            fetch: this.fetchImpl,
            capacity: eventOptions.capacity ?? 10000,
            flushIntervalMs: eventOptions.flushIntervalMs ?? 5000,
            dedupTtlMs: eventOptions.exposureDedupTtlMs ?? 3600000,
            dedupCapacity: eventOptions.exposureDedupCapacity ?? 10000,
            timeoutMs: options.requestTimeoutMs ?? 10000,
            logger: this.logger,
          });
    if (options.bootstrap) {
      this.data.replace(options.bootstrap);
      this.source = 'bootstrap';
    }
    if (options.offline || !this.valid) {
      if (options.offline) this.source = options.bootstrap ? 'bootstrap' : 'offline';
      this.markInitialized(this.source);
      return;
    }
    this.events?.start();
    if (typeof process !== 'undefined' && typeof process.on === 'function')
      process.on('beforeExit', this.beforeExit);
    void this.loadPersistent();
    if (options.stream === false) this.startPolling(0);
    else this.startStream();
    if (options.diagnostics?.enabled !== false) {
      this.diagnosticsTimer = setInterval(
        () => this.sendDiagnostic(),
        options.diagnostics?.intervalMs ?? 15 * 60000,
      );
      (this.diagnosticsTimer as { unref?: () => void }).unref?.();
    }
  }

  private async loadPersistent(): Promise<void> {
    const store = this.options.persistentStore;
    if (!store || this.data.initialized) return;
    try {
      const raw = await store.get(PERSIST_KEY);
      if (!raw || this.data.initialized) return;
      this.data.replace(JSON.parse(raw) as Ruleset);
      this.data.initialized = false;
      this.source = 'persistent';
      this.logger.info('loaded last known ruleset from persistent store');
    } catch (error) {
      this.logger.warn(`persistent store read failed: ${String(error)}`);
    }
  }

  private persist(): void {
    const store = this.options.persistentStore;
    if (!store) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      store
        .set(PERSIST_KEY, JSON.stringify(this.data.snapshot()))
        .catch((error: unknown) => this.logger.warn(`persistent store write failed: ${String(error)}`));
    }, 100);
    (this.persistTimer as { unref?: () => void }).unref?.();
  }

  private markInitialized(source: DataSourceKind): void {
    if (this.initDurationMs === null) {
      this.initDurationMs = Date.now() - this.startedAt;
      this.emitter.emit('ready', { source });
      if (!this.options.offline && this.valid) this.sendDiagnostic();
    }
    const resolvers = this.readyResolvers;
    this.readyResolvers = [];
    for (const resolve of resolvers) resolve({ initialized: true, source, timedOut: false });
  }

  private receivedRuleset(ruleset: Ruleset, source: DataSourceKind): void {
    const hadData = this.data.initialized || this.source === 'persistent';
    const changed = hadData ? this.data.replace(ruleset) : (this.data.replace(ruleset), []);
    this.source = source;
    this.persist();
    this.markInitialized(source);
    for (const key of changed) this.emitter.emit('update', { key, kind: 'flag', version: this.data.version });
  }

  private startStream(): void {
    this.sse = new SseClient({
      url: `${this.baseUrl}/sdk/v1/stream`,
      gate: this.dataGate,
      headers: this.headers,
      fetch: this.fetchImpl,
      initialRetryMs: this.options.streamInitialRetryMs ?? 1000,
      maxRetryMs: this.options.streamMaxRetryMs ?? 30000,
      heartbeatTimeoutMs: this.options.heartbeatTimeoutMs ?? 45000,
      onOpen: () => {
        this.streamConnected = true;
      },
      onMessage: (message) => {
        try {
          if (message.event === 'put') {
            const payload = JSON.parse(message.data) as { ruleset: Ruleset };
            if (!payload || typeof payload.ruleset !== 'object') throw new Error('malformed put event');
            this.stopPolling();
            this.sse?.resetBackoff();
            this.receivedRuleset(payload.ruleset, 'stream');
          } else if (message.event === 'patch') {
            const patch = JSON.parse(message.data) as PatchMessage;
            if (
              !patch ||
              (patch.kind !== 'flag' && patch.kind !== 'segment') ||
              typeof patch.key !== 'string'
            ) {
              throw new Error('malformed patch event');
            }
            if (this.data.applyPatch(patch)) {
              this.persist();
              this.emitter.emit('update', { key: patch.key, kind: patch.kind, version: patch.version });
            }
          }
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.reportError(failure);
          this.sse?.fail(failure);
        }
      },
      onError: (error, retryInMs) => {
        const wasConnected = this.streamConnected;
        this.streamConnected = false;
        this.lastError = error.message;
        this.logger.warn(`stream error: ${error.message}; reconnecting in ${retryInMs} ms`);
        if (wasConnected || this.data.initialized) this.emitter.emit('stale', { reason: error.message });
        this.emitter.emit('error', error);
        if (!this.pollTimer) this.startPolling(0);
      },
    });
    this.sse.start();
  }

  private startPolling(delayMs: number): void {
    if (this.closed || this.pollTimer) return;
    const run = async () => {
      this.pollTimer = null;
      const blocked = this.dataGate.remaining();
      if (blocked > 0) {
        this.pollTimer = setTimeout(() => void run(), blocked);
        (this.pollTimer as { unref?: () => void }).unref?.();
        return;
      }
      await this.poll();
      if (this.closed) return;
      if (this.options.stream === false || !this.streamConnected) {
        this.pollTimer = setTimeout(
          () => void run(),
          Math.max(this.options.pollIntervalMs ?? 30000, this.dataGate.remaining()),
        );
        (this.pollTimer as { unref?: () => void }).unref?.();
      }
    };
    this.pollTimer = setTimeout(() => void run(), Math.max(delayMs, this.dataGate.remaining()));
    (this.pollTimer as { unref?: () => void }).unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  async poll(): Promise<void> {
    try {
      const headers: Record<string, string> = { ...this.headers };
      if (this.etag && this.data.initialized) headers['if-none-match'] = this.etag;
      const response = await this.fetchImpl(`${this.baseUrl}/sdk/v1/ruleset`, {
        headers,
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10000),
      });
      if (response.status === 304) {
        this.markInitialized(this.source === 'none' ? 'polling' : this.source);
        return;
      }
      if (!response.ok) {
        const wait = this.dataGate.note(response);
        throw new Error(
          `ruleset responded with ${response.status}${wait > 0 ? `, retry after ${wait} ms` : ''}`,
        );
      }
      const ruleset = (await response.json()) as Ruleset;
      if (!ruleset || typeof ruleset.flags !== 'object') throw new Error('malformed ruleset');
      this.etag = response.headers.get('etag');
      if (ruleset.version !== this.data.version || !this.data.initialized)
        this.receivedRuleset(ruleset, this.streamConnected ? 'stream' : 'polling');
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`polling failed: ${this.lastError}`);
      this.emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private reportError(error: Error): void {
    this.lastError = error.message;
    this.logger.error(error.message);
    this.emitter.emit('error', error);
  }

  waitForInitialization(options: { timeoutMs?: number } = {}): Promise<InitializationResult> {
    if (this.data.initialized || this.initDurationMs !== null) {
      return Promise.resolve({ initialized: true, source: this.source, timedOut: false });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.readyResolvers = this.readyResolvers.filter((r) => r !== done);
        const result: InitializationResult = { initialized: false, source: this.source, timedOut: true };
        if (this.lastError) result.error = this.lastError;
        resolve(result);
      }, options.timeoutMs ?? 5000);
      const done = (result: InitializationResult) => {
        clearTimeout(timer);
        resolve(result);
      };
      this.readyResolvers.push(done);
    });
  }

  initialized(): boolean {
    return this.data.initialized;
  }

  private detail<T>(
    key: string,
    context: Context,
    defaultValue: T,
    expectedKind: FlagKind | undefined,
    track = true,
  ): FlagDetail<T> {
    try {
      if (!this.data.initialized && this.source !== 'persistent' && this.source !== 'bootstrap') {
        return {
          value: defaultValue,
          variationId: null,
          reason: { kind: 'ERROR', errorKind: 'CLIENT_NOT_READY' },
        };
      }
      const flag = this.data.store.getFlag(key);
      const result = evaluate<T>(flag, flag?.config, context, this.data.store, {
        defaultValue,
        expectedKind,
      });
      if (track && this.events && flag && isValidContext(context)) {
        const { key: contextKey, kind } = eventContextKey(context);
        this.events.exposure({
          flagKey: key,
          variationId: result.variationId,
          contextKey,
          contextKind: kind,
          inExperiment: 'inExperiment' in result.reason && result.reason.inExperiment === true,
          version: flag.config?.version,
          reason: result.reason.kind,
          attributes: attributeNames(context),
        });
      }
      return result;
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
      return { value: defaultValue, variationId: null, reason: { kind: 'ERROR', errorKind: 'EXCEPTION' } };
    }
  }

  variation<K extends KnownFlagKey>(key: K, context: Context, defaultValue: FlagTypes[K]): FlagTypes[K];
  variation<T = unknown>(key: string, context: Context, defaultValue: T): T;
  variation(key: string, context: Context, defaultValue: unknown): unknown {
    return this.detail(key, context, defaultValue, undefined).value;
  }

  variationDetail<K extends KnownFlagKey>(
    key: K,
    context: Context,
    defaultValue: FlagTypes[K],
  ): FlagDetail<FlagTypes[K]>;
  variationDetail<T = unknown>(key: string, context: Context, defaultValue: T): FlagDetail<T>;
  variationDetail(key: string, context: Context, defaultValue: unknown): FlagDetail<unknown> {
    return this.detail(key, context, defaultValue, undefined);
  }

  boolVariation(key: string, context: Context, defaultValue: boolean): boolean {
    return this.detail(key, context, defaultValue, 'boolean').value;
  }

  boolVariationDetail(key: string, context: Context, defaultValue: boolean): FlagDetail<boolean> {
    return this.detail(key, context, defaultValue, 'boolean');
  }

  stringVariation(key: string, context: Context, defaultValue: string): string {
    return this.detail(key, context, defaultValue, 'string').value;
  }

  stringVariationDetail(key: string, context: Context, defaultValue: string): FlagDetail<string> {
    return this.detail(key, context, defaultValue, 'string');
  }

  numberVariation(key: string, context: Context, defaultValue: number): number {
    return this.detail(key, context, defaultValue, 'number').value;
  }

  numberVariationDetail(key: string, context: Context, defaultValue: number): FlagDetail<number> {
    return this.detail(key, context, defaultValue, 'number');
  }

  jsonVariation<T = unknown>(key: string, context: Context, defaultValue: T): T {
    return this.detail(key, context, defaultValue, 'json').value;
  }

  jsonVariationDetail<T = unknown>(key: string, context: Context, defaultValue: T): FlagDetail<T> {
    return this.detail(key, context, defaultValue, 'json');
  }

  evaluateWithoutEvents<T>(
    key: string,
    context: Context,
    defaultValue: T,
    expectedKind?: FlagKind,
  ): FlagDetail<T> {
    return this.detail(key, context, defaultValue, expectedKind, false);
  }

  allFlagsState(
    context: Context,
    options: { clientSideOnly?: boolean; withReasons?: boolean } = {},
  ): AllFlagsState {
    try {
      const valid = this.data.initialized || this.source === 'persistent' || this.source === 'bootstrap';
      const flags =
        valid && isValidContext(context)
          ? evaluateAll(this.data.flags(), this.data.store, context, options)
          : {};
      return { valid, flags, toJSON: () => ({ valid, flags }) };
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
      return { valid: false, flags: {}, toJSON: () => ({ valid: false, flags: {} }) };
    }
  }

  track(eventKey: string, context: Context, options: { value?: number; data?: unknown } = {}): void {
    try {
      if (!this.events || !isValidContext(context) || typeof eventKey !== 'string' || eventKey.length === 0)
        return;
      this.events.custom(
        eventKey,
        eventContextKey(context).key,
        typeof options.value === 'number' ? options.value : undefined,
        options.data,
      );
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  on<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void): () => void {
    return this.emitter.on(event, listener);
  }

  off<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void): void {
    this.emitter.off(event, listener);
  }

  status() {
    return {
      initialized: this.data.initialized,
      source: this.source,
      streamConnected: this.streamConnected,
      version: this.data.version,
      reconnects: this.sse?.reconnects ?? 0,
      throttled: this.dataGate.throttled + (this.events?.gate.throttled ?? 0),
      eventsInQueue: this.events?.queueSize ?? 0,
      droppedEvents: this.events?.dropped ?? 0,
      dedupedExposures: this.events?.deduped ?? 0,
      lastError: this.lastError ?? null,
    };
  }

  private sendDiagnostic(): void {
    if (!this.events) return;
    this.events.diagnostic({
      id: this.instanceId,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      initDurationMs: this.initDurationMs,
      reconnects: this.sse?.reconnects ?? 0,
      eventsInQueue: this.events.queueSize,
      droppedEvents: this.events.dropped,
      dedupedExposures: this.events.deduped,
      dataSource: this.source,
    });
  }

  async flush(): Promise<void> {
    try {
      await this.events?.flush();
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.sse?.stop();
    this.stopPolling();
    if (this.diagnosticsTimer) clearInterval(this.diagnosticsTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.events?.stop();
    if (typeof process !== 'undefined' && typeof process.off === 'function')
      process.off('beforeExit', this.beforeExit);
    await this.flush();
    await this.events?.discardIfThrottled().catch(() => undefined);
    this.emitter.removeAll();
  }
}

export function init(options: FlagsOptions): FlagsClient {
  return new FlagsClient(options);
}
