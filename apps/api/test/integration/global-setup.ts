import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import { Db } from '../../src/db/db';
import { createDatabase, dropDatabase, migrate, withDatabase } from '../../src/db/migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
    redisPrefix: string;
  }
}

export default async function setup(project: TestProject) {
  const id = randomBytes(4).toString('hex');
  const stops: Array<() => Promise<unknown>> = [];
  let adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://127.0.0.1:5432/postgres';
  let redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/2';
  if (process.env.TESTCONTAINERS === '1') {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const { RedisContainer } = await import('@testcontainers/redis');
    const pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    const redis = await new RedisContainer('redis:7-alpine').start();
    stops.push(
      () => pg.stop(),
      () => redis.stop(),
    );
    adminUrl = withDatabase(pg.getConnectionUri(), 'postgres');
    redisUrl = redis.getConnectionUrl();
  }
  const name = `ffp_test_${id}`;
  await createDatabase(adminUrl, name);
  const databaseUrl = withDatabase(adminUrl, name);
  const db = new Db(databaseUrl, 2);
  await migrate(db);
  await db.close();
  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redisUrl);
  project.provide('redisPrefix', `ffp_test_${id}`);
  return async () => {
    await dropDatabase(adminUrl, name).catch(() => undefined);
    for (const stop of stops) await stop();
  };
}
