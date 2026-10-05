export interface BucketPolicy {
  ratePerSecond: number;
  burst: number;
}

export interface TakeResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    readonly policy: BucketPolicy,
    private readonly maxBuckets = 100000,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  private refill(bucket: Bucket, now: number): void {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.policy.burst, bucket.tokens + (elapsed / 1000) * this.policy.ratePerSecond);
    bucket.updatedAt = now;
  }

  private bucket(id: string, now: number): Bucket {
    const existing = this.buckets.get(id);
    if (existing) {
      this.refill(existing, now);
      this.buckets.delete(id);
      this.buckets.set(id, existing);
      return existing;
    }
    if (this.buckets.size >= this.maxBuckets) {
      this.sweep(now);
      while (this.buckets.size >= this.maxBuckets) {
        const oldest = this.buckets.keys().next().value;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
    }
    const created = { tokens: this.policy.burst, updatedAt: now };
    this.buckets.set(id, created);
    return created;
  }

  private retryAfter(missing: number): number {
    return Math.ceil((missing / this.policy.ratePerSecond) * 1000);
  }

  take(id: string, cost = 1): TakeResult {
    const now = this.now();
    const bucket = this.bucket(id, now);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    return {
      allowed: false,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs: this.retryAfter(cost - bucket.tokens),
    };
  }

  peek(id: string, cost = 1): TakeResult {
    const existing = this.buckets.get(id);
    if (!existing) return { allowed: true, remaining: this.policy.burst, retryAfterMs: 0 };
    this.refill(existing, this.now());
    if (existing.tokens >= cost)
      return { allowed: true, remaining: Math.floor(existing.tokens), retryAfterMs: 0 };
    return {
      allowed: false,
      remaining: Math.floor(existing.tokens),
      retryAfterMs: this.retryAfter(cost - existing.tokens),
    };
  }

  sweep(now = this.now()): number {
    let removed = 0;
    for (const [id, bucket] of this.buckets) {
      this.refill(bucket, now);
      if (bucket.tokens >= this.policy.burst) {
        this.buckets.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

export type LimitScope = 'ip' | 'key' | 'invalid-key' | 'events';

export interface RateLimitConfig {
  enabled: boolean;
  ip: BucketPolicy;
  serverKey: BucketPolicy;
  clientKey: BucketPolicy;
  invalidKey: BucketPolicy;
  serverEvents: BucketPolicy;
  clientEvents: BucketPolicy;
  maxBuckets: number;
}

export interface LimitDecision {
  allowed: boolean;
  scope?: LimitScope;
  retryAfterMs: number;
}

export class RelayRateLimits {
  readonly ip: TokenBucketLimiter;
  readonly serverKey: TokenBucketLimiter;
  readonly clientKey: TokenBucketLimiter;
  readonly invalidKey: TokenBucketLimiter;
  readonly serverEvents: TokenBucketLimiter;
  readonly clientEvents: TokenBucketLimiter;
  readonly rejected: Record<LimitScope, number> = { ip: 0, key: 0, 'invalid-key': 0, events: 0 };
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    readonly config: RateLimitConfig,
    now: () => number = Date.now,
  ) {
    const make = (policy: BucketPolicy) => new TokenBucketLimiter(policy, config.maxBuckets, now);
    this.ip = make(config.ip);
    this.serverKey = make(config.serverKey);
    this.clientKey = make(config.clientKey);
    this.invalidKey = make(config.invalidKey);
    this.serverEvents = make(config.serverEvents);
    this.clientEvents = make(config.clientEvents);
  }

  start(intervalMs = 60000): void {
    if (!this.config.enabled || this.sweeper) return;
    this.sweeper = setInterval(() => {
      for (const limiter of this.limiters()) limiter.sweep();
    }, intervalMs);
    this.sweeper.unref();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private limiters(): TokenBucketLimiter[] {
    return [this.ip, this.serverKey, this.clientKey, this.invalidKey, this.serverEvents, this.clientEvents];
  }

  private deny(scope: LimitScope, retryAfterMs: number): LimitDecision {
    this.rejected[scope]++;
    return { allowed: false, scope, retryAfterMs };
  }

  beforeKeyLookup(ip: string): LimitDecision {
    if (!this.config.enabled) return { allowed: true, retryAfterMs: 0 };
    const check = this.invalidKey.peek(ip);
    return check.allowed ? { allowed: true, retryAfterMs: 0 } : this.deny('invalid-key', check.retryAfterMs);
  }

  invalidKeyUsed(ip: string): void {
    if (this.config.enabled) this.invalidKey.take(ip);
  }

  request(ip: string, keyId: string, kind: 'server' | 'client'): LimitDecision {
    if (!this.config.enabled) return { allowed: true, retryAfterMs: 0 };
    if (kind === 'client') {
      const byIp = this.ip.peek(ip);
      if (!byIp.allowed) return this.deny('ip', byIp.retryAfterMs);
    }
    const byKey = (kind === 'client' ? this.clientKey : this.serverKey).take(keyId);
    if (!byKey.allowed) return this.deny('key', byKey.retryAfterMs);
    if (kind === 'client') this.ip.take(ip);
    return { allowed: true, retryAfterMs: 0 };
  }

  events(keyId: string, kind: 'server' | 'client', count: number): LimitDecision | 'too-large' {
    if (!this.config.enabled || count === 0) return { allowed: true, retryAfterMs: 0 };
    const limiter = kind === 'client' ? this.clientEvents : this.serverEvents;
    if (count > limiter.policy.burst) return 'too-large';
    const result = limiter.take(keyId, count);
    return result.allowed ? { allowed: true, retryAfterMs: 0 } : this.deny('events', result.retryAfterMs);
  }
}

export function parsePolicy(value: string | undefined, fallback: BucketPolicy): BucketPolicy {
  if (!value) return fallback;
  const [rate, burst] = value.split(':').map((part) => Number(part.trim()));
  if (!rate || !Number.isFinite(rate) || rate <= 0) return fallback;
  const size = burst && Number.isFinite(burst) && burst > 0 ? burst : rate;
  return { ratePerSecond: rate, burst: Math.max(1, size) };
}

export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}
