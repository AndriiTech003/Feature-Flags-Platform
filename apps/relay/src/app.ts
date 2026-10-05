import type { Server } from 'node:http';
import Fastify, {
  type FastifyHttpOptions,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { Redis } from 'ioredis';
import {
  changesChannel,
  eventBatchSchema,
  sdkKeysChannel,
  type ChangeNotification,
} from '@ashamrai/flags-contracts';
import { contextKinds, contextOfKind, type Context } from '@ashamrai/flags-evaluator';
import type { RelayConfig } from './config';
import { clientFlags, Hub, sseHeaders } from './hub';
import { PostgresSource } from './pg-source';
import { RelayRateLimits, retryAfterSeconds, type LimitDecision } from './rate-limit';
import type { KeyInfo, RelaySource } from './source';

export interface RelayOptions {
  source?: RelaySource;
  redis?: boolean;
}

export interface RunningRelay {
  app: FastifyInstance;
  hub: Hub;
  source: RelaySource;
  limits: RelayRateLimits;
  url: string;
  close(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    sdkKey?: KeyInfo;
    sdkKeyId?: string;
  }
}

const CLIENT_EVENTS_MAX_BYTES = 1024 * 1024;
const EVALUATE_MAX_BYTES = 64 * 1024;

function keyFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header) return header.startsWith('Bearer ') ? header.slice(7) : header;
  const query = (request.query as Record<string, unknown>).key;
  return typeof query === 'string' ? query : null;
}

function decodeContext(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function attributesOf(context: Context): Array<{ kind: string; name: string }> {
  const out: Array<{ kind: string; name: string }> = [];
  for (const kind of contextKinds(context)) {
    const ctx = contextOfKind(context, kind);
    if (!ctx) continue;
    for (const name of Object.keys(ctx)) if (name !== 'kind') out.push({ kind, name });
  }
  return out;
}

export async function createRelay(config: RelayConfig, options: RelayOptions = {}): Promise<RunningRelay> {
  const source = options.source ?? new PostgresSource(config.databaseUrl, config.keyCacheTtlMs);
  const hub = new Hub(source);
  const limits = new RelayRateLimits(config.rateLimit);
  const serverOptions: FastifyHttpOptions<Server> = {
    logger: config.logRequests,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy:
      typeof config.trustProxy === 'number'
        ? (_address: string, hop: number) => hop < (config.trustProxy as number)
        : config.trustProxy,
  };
  const app = Fastify(serverOptions);

  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-headers', 'authorization, content-type, if-none-match, last-event-id');
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    reply.header('access-control-expose-headers', 'etag, retry-after');
    reply.header('access-control-max-age', '600');
    if (request.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });

  const limited = (reply: FastifyReply, decision: LimitDecision) => {
    reply.header('retry-after', String(retryAfterSeconds(decision.retryAfterMs)));
    return reply.code(429).send({ error: 'rate limit exceeded', scope: decision.scope });
  };

  const requireKey =
    (kind: 'server' | 'client' | 'any') => async (request: FastifyRequest, reply: FastifyReply) => {
      const key = keyFrom(request);
      if (!key) return reply.code(401).send({ error: 'missing sdk key' });
      const gate = limits.beforeKeyLookup(request.ip);
      if (!gate.allowed) return limited(reply, gate);
      let info: KeyInfo | null;
      try {
        info = await source.resolveKey(key);
      } catch {
        return reply.code(503).send({ error: 'key lookup unavailable' });
      }
      if (!info) {
        limits.invalidKeyUsed(request.ip);
        return reply.code(401).send({ error: 'invalid sdk key' });
      }
      if (kind !== 'any' && info.kind !== kind)
        return reply.code(403).send({ error: `${kind} key required` });
      const decision = limits.request(request.ip, key, info.kind);
      if (!decision.allowed) return limited(reply, decision);
      if (
        info.kind === 'client' &&
        request.method === 'POST' &&
        Number(request.headers['content-length'] ?? 0) > CLIENT_EVENTS_MAX_BYTES
      )
        return reply.code(413).send({ error: 'request body too large for a client key' });
      request.sdkKey = info;
      request.sdkKeyId = key;
    };

  app.get('/health', async () => ({
    status: 'ok',
    ...hub.metrics,
    rateLimited: limits.rejected,
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
  }));

  app.get('/metrics', async (_request, reply) => {
    const m = hub.metrics;
    const lines = [
      '# TYPE relay_sse_connections gauge',
      `relay_sse_connections{kind="server"} ${m.serverConnections}`,
      `relay_sse_connections{kind="client"} ${m.clientConnections}`,
      '# TYPE relay_patches_sent_total counter',
      `relay_patches_sent_total ${m.patchesSent}`,
      '# TYPE relay_puts_sent_total counter',
      `relay_puts_sent_total ${m.putsSent}`,
      '# TYPE relay_evaluations_total counter',
      `relay_evaluations_total ${m.evaluations}`,
      '# TYPE relay_events_ingested_total counter',
      `relay_events_ingested_total ${m.eventsIngested}`,
      '# TYPE relay_ruleset_requests_total counter',
      `relay_ruleset_requests_total ${m.rulesetRequests}`,
      `relay_ruleset_not_modified_total ${m.notModified}`,
      '# TYPE relay_last_patch_latency_ms gauge',
      `relay_last_patch_latency_ms ${m.lastPatchLatencyMs ?? 0}`,
      `relay_ruleset_reloads_total ${m.reloads}`,
      '# TYPE relay_rate_limited_total counter',
      ...Object.entries(limits.rejected).map(
        ([scope, count]) => `relay_rate_limited_total{scope="${scope}"} ${count}`,
      ),
    ];
    reply.type('text/plain; version=0.0.4');
    return lines.join('\n') + '\n';
  });

  app.get('/sdk/v1/ruleset', { onRequest: requireKey('server') }, async (request, reply) => {
    hub.metrics.rulesetRequests++;
    const snapshot = await hub.snapshot(request.sdkKey!.envId);
    if (!snapshot) return reply.code(404).send({ error: 'environment not found' });
    const etag = `"${snapshot.version}"`;
    reply.header('etag', etag);
    reply.header('cache-control', 'no-cache');
    const ifNoneMatch = request.headers['if-none-match'];
    if (
      ifNoneMatch &&
      ifNoneMatch
        .split(',')
        .map((s) => s.trim().replace(/^W\//, ''))
        .includes(etag)
    ) {
      hub.metrics.notModified++;
      return reply.code(304).send();
    }
    return snapshot.ruleset;
  });

  app.get('/sdk/v1/stream', { onRequest: requireKey('server') }, async (request, reply) => {
    const snapshot = await hub.snapshot(request.sdkKey!.envId);
    if (!snapshot) return reply.code(404).send({ error: 'environment not found' });
    reply.hijack();
    reply.raw.writeHead(200, sseHeaders());
    reply.raw.write(':ok\n\n');
    hub.addServer(snapshot.envId, reply.raw, snapshot);
  });

  app.post(
    '/sdk/v1/evaluate',
    { onRequest: requireKey('client'), bodyLimit: EVALUATE_MAX_BYTES },
    async (request, reply) => {
      const body = (request.body ?? {}) as { context?: unknown; withReasons?: boolean };
      if (typeof body.context !== 'object' || body.context === null)
        return reply.code(400).send({ error: 'context is required' });
      const snapshot = await hub.snapshot(request.sdkKey!.envId);
      if (!snapshot) return reply.code(404).send({ error: 'environment not found' });
      const context = body.context as Context;
      hub.metrics.evaluations++;
      void source.recordAttributes(snapshot.envId, attributesOf(context)).catch(() => undefined);
      return { version: snapshot.version, flags: clientFlags(snapshot, context, body.withReasons === true) };
    },
  );

  app.get('/sdk/v1/client-stream', { onRequest: requireKey('client') }, async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const context = query.ctx ? decodeContext(query.ctx) : null;
    if (!context || typeof context !== 'object')
      return reply.code(400).send({ error: 'ctx must be base64 encoded JSON' });
    const snapshot = await hub.snapshot(request.sdkKey!.envId);
    if (!snapshot) return reply.code(404).send({ error: 'environment not found' });
    reply.hijack();
    reply.raw.writeHead(200, sseHeaders());
    reply.raw.write(':ok\n\n');
    hub.addClient(snapshot.envId, reply.raw, context as Context, query.reasons === 'true', snapshot);
  });

  app.post('/sdk/v1/events', { onRequest: requireKey('any') }, async (request, reply) => {
    const raw = request.body;
    const parsed = eventBatchSchema.safeParse(Array.isArray(raw) ? { events: raw } : raw);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid events',
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const quota = limits.events(request.sdkKeyId!, request.sdkKey!.kind, parsed.data.events.length);
    if (quota === 'too-large')
      return reply.code(413).send({ error: 'event batch exceeds the per-key quota, send smaller batches' });
    if (!quota.allowed) return limited(reply, quota);
    const result = await source.ingest(request.sdkKey!.envId, parsed.data);
    hub.metrics.eventsIngested += parsed.data.events.length;
    return reply.code(202).send({ accepted: parsed.data.events.length, ...result });
  });

  let subscriber: Redis | null = null;
  if (options.redis !== false) {
    subscriber = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    subscriber.on('error', () => undefined);
    const channel = changesChannel(config.redisPrefix);
    const keysChannel = sdkKeysChannel(config.redisPrefix);
    await subscriber.subscribe(channel, keysChannel);
    subscriber.on('message', (ch: string, message: string) => {
      if (ch === keysChannel) {
        source.invalidateKeys();
        return;
      }
      try {
        void hub.handleNotification(JSON.parse(message) as ChangeNotification);
      } catch {
        return;
      }
    });
  }

  hub.start(config.heartbeatMs, config.versionCheckMs);
  limits.start();
  await app.listen({ port: config.port, host: config.host });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  return {
    app,
    hub,
    source,
    limits,
    url: `http://${config.host}:${port}`,
    close: async () => {
      hub.stop();
      limits.stop();
      await subscriber?.quit().catch(() => undefined);
      await app.close();
      await source.close();
    },
  };
}
