export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  jwtSecret: string;
  jwtTtlSeconds: number;
  dashboardUrl: string;
  relayUrl: string;
  workerEnabled: boolean;
  workerIntervalMs: number;
  webhookTimeoutMs: number;
  github: { clientId: string; clientSecret: string } | null;
  logRequests: boolean;
  outboxPublisher: boolean;
  outboxPollMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.API_PORT ?? env.PORT ?? 4200),
    host: env.API_HOST ?? '127.0.0.1',
    databaseUrl: env.DATABASE_URL ?? 'postgres://127.0.0.1:5432/ffp',
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379/2',
    redisPrefix: env.REDIS_PREFIX ?? 'ffp',
    jwtSecret: env.JWT_SECRET ?? 'dev-only-secret-change-me',
    jwtTtlSeconds: Number(env.JWT_TTL_SECONDS ?? 60 * 60 * 12),
    dashboardUrl: env.DASHBOARD_URL ?? 'http://127.0.0.1:4220',
    relayUrl: env.RELAY_URL ?? 'http://127.0.0.1:4210',
    workerEnabled: (env.WORKER_ENABLED ?? 'true') !== 'false',
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 1000),
    webhookTimeoutMs: Number(env.WEBHOOK_TIMEOUT_MS ?? 5000),
    github:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
        : null,
    logRequests: env.LOG_REQUESTS === 'true',
    outboxPublisher: (env.OUTBOX_PUBLISHER ?? 'true') !== 'false',
    outboxPollMs: Number(env.OUTBOX_POLL_MS ?? 1000),
  };
}
