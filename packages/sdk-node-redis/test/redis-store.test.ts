import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { init, silentLogger } from '@ashamrai/flags-node';
import { RedisPersistentStore } from '../src';

const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/2', {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const prefix = `ffp_test_${Math.random().toString(36).slice(2)}:`;

afterAll(async () => {
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});

describe('RedisPersistentStore', () => {
  it('stores and loads values with a prefix and ttl', async () => {
    const store = new RedisPersistentStore({ client: redis, prefix, ttlSeconds: 60 });
    await store.set('ruleset', '{"version":3}');
    expect(await store.get('ruleset')).toBe('{"version":3}');
    expect(await redis.ttl(`${prefix}ruleset`)).toBeGreaterThan(0);
    expect(await store.get('missing')).toBeNull();
  });

  it('lets a restarted SDK serve last known values while the relay is unreachable', async () => {
    const store = new RedisPersistentStore({ client: redis, prefix });
    await store.set(
      'ffp:ruleset',
      JSON.stringify({
        version: 9,
        flags: {
          f: {
            key: 'f',
            kind: 'boolean',
            salt: 's',
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
              version: 9,
            },
          },
        },
        segments: {},
      }),
    );
    const client = init({
      sdkKey: 'srv',
      baseUrl: 'http://127.0.0.1:9',
      persistentStore: store,
      logger: silentLogger,
      events: { enabled: false },
    });
    const deadline = Date.now() + 3000;
    while (client.status().source !== 'persistent' && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(client.boolVariation('f', { kind: 'user', key: 'u' }, false)).toBe(true);
    await client.close();
  });
});
