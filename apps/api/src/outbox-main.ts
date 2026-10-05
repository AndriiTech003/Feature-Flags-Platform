import { Redis } from 'ioredis';
import { loadConfig } from './config';
import { Db } from './db/db';
import { OutboxPublisher, outboxRedisChannel } from './outbox/outbox';

const config = loadConfig();
const db = new Db(config.databaseUrl, 2);
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
redis.on('error', () => undefined);
const publisher = new OutboxPublisher({
  db,
  listenUrl: config.databaseUrl,
  publish: async (topic, payload) => {
    await redis.publish(outboxRedisChannel(config.redisPrefix, topic), payload);
  },
  pollIntervalMs: config.outboxPollMs,
  onError: (error) => console.error(`outbox publisher: ${error.message}`),
});
await publisher.start();
console.log(`outbox publisher running, ${await publisher.pending()} pending`);
const shutdown = async () => {
  await publisher.stop();
  await Promise.allSettled([redis.quit(), db.close()]);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
