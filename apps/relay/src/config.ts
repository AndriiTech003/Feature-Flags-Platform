import { parsePolicy, type RateLimitConfig } from './rate-limit';

export interface RelayConfig {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  heartbeatMs: number;
  versionCheckMs: number;
  keyCacheTtlMs: number;
  logRequests: boolean;
  trustProxy: boolean | number | string;
  rateLimit: RateLimitConfig;
}

export const defaultRateLimits: RateLimitConfig = {
  enabled: true,
  ip: { ratePerSecond: 50, burst: 200 },
  serverKey: { ratePerSecond: 100, burst: 500 },
  clientKey: { ratePerSecond: 2000, burst: 5000 },
  invalidKey: { ratePerSecond: 2, burst: 20 },
  serverEvents: { ratePerSecond: 20000, burst: 200000 },
  clientEvents: { ratePerSecond: 5000, burst: 20000 },
  maxBuckets: 100000,
};

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 ? hops : value;
}

export function loadRateLimits(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const d = defaultRateLimits;
  return {
    enabled: env.RELAY_RATE_LIMIT !== 'off' && env.RELAY_RATE_LIMIT !== 'false',
    ip: parsePolicy(env.RELAY_RATE_LIMIT_IP, d.ip),
    serverKey: parsePolicy(env.RELAY_RATE_LIMIT_SERVER_KEY, d.serverKey),
    clientKey: parsePolicy(env.RELAY_RATE_LIMIT_CLIENT_KEY, d.clientKey),
    invalidKey: parsePolicy(env.RELAY_RATE_LIMIT_INVALID_KEY, d.invalidKey),
    serverEvents: parsePolicy(env.RELAY_RATE_LIMIT_SERVER_EVENTS, d.serverEvents),
    clientEvents: parsePolicy(env.RELAY_RATE_LIMIT_CLIENT_EVENTS, d.clientEvents),
    maxBuckets: Number(env.RELAY_RATE_LIMIT_MAX_BUCKETS ?? d.maxBuckets),
  };
}

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    port: Number(env.RELAY_PORT ?? env.PORT ?? 4210),
    host: env.RELAY_HOST ?? '127.0.0.1',
    databaseUrl: env.DATABASE_URL ?? 'postgres://127.0.0.1:5432/ffp',
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379/2',
    redisPrefix: env.REDIS_PREFIX ?? 'ffp',
    heartbeatMs: Number(env.RELAY_HEARTBEAT_MS ?? 15000),
    versionCheckMs: Number(env.RELAY_VERSION_CHECK_MS ?? 30000),
    keyCacheTtlMs: Number(env.RELAY_KEY_CACHE_TTL_MS ?? 30000),
    logRequests: env.LOG_REQUESTS === 'true',
    trustProxy: parseTrustProxy(env.RELAY_TRUST_PROXY),
    rateLimit: loadRateLimits(env),
  };
}
