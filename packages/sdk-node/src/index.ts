export { init, FlagsClient, ConfigurationError, eventContextKey } from './client';
export { consoleLogger, silentLogger } from './logger';
export { SseParser, backoffDelay, type SseMessage } from './sse';
export { LruDedupe } from './events';
export { SDK_NAME, SDK_VERSION } from './version';
export class MemoryPersistentStore {
  private readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}
export type * from './types';
export { parseRetryAfter, MAX_RETRY_AFTER_MS } from './retry-after';
