import type { PersistentStore } from '@ashamrai/flags-node';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

export interface RedisPersistentStoreOptions {
  client: RedisLike;
  prefix?: string;
  ttlSeconds?: number;
}

export class RedisPersistentStore implements PersistentStore {
  private readonly prefix: string;

  constructor(private readonly options: RedisPersistentStoreOptions) {
    this.prefix = options.prefix ?? 'flags:';
  }

  async get(key: string): Promise<string | null> {
    return this.options.client.get(`${this.prefix}${key}`);
  }

  async set(key: string, value: string): Promise<void> {
    if (this.options.ttlSeconds)
      await this.options.client.set(`${this.prefix}${key}`, value, 'EX', this.options.ttlSeconds);
    else await this.options.client.set(`${this.prefix}${key}`, value);
  }
}
