import type { ServerResponse } from 'node:http';
import type { ChangeNotification } from '@ashamrai/flags-contracts';
import { createStore, evaluateAll, type Context, type FlagState } from '@ashamrai/flags-evaluator';
import type { RelaySource, RulesetSnapshot } from './source';

export interface Subscriber {
  id: number;
  envId: string;
  res: ServerResponse;
}

export interface ClientSubscriber extends Subscriber {
  context: Context;
  withReasons: boolean;
  last: Record<string, FlagState>;
}

export interface RelayMetrics {
  serverConnections: number;
  clientConnections: number;
  patchesSent: number;
  putsSent: number;
  evaluations: number;
  eventsIngested: number;
  rulesetRequests: number;
  notModified: number;
  lastPatchLatencyMs: number | null;
  reloads: number;
}

export function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  };
}

export function writeEvent(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function clientFlags(
  snapshot: RulesetSnapshot,
  context: Context,
  withReasons: boolean,
): Record<string, FlagState> {
  return evaluateAll(Object.values(snapshot.ruleset.flags), createStore(snapshot.ruleset), context, {
    clientSideOnly: true,
    withReasons,
  });
}

export class Hub {
  readonly metrics: RelayMetrics = {
    serverConnections: 0,
    clientConnections: 0,
    patchesSent: 0,
    putsSent: 0,
    evaluations: 0,
    eventsIngested: 0,
    rulesetRequests: 0,
    notModified: 0,
    lastPatchLatencyMs: null,
    reloads: 0,
  };
  private readonly cache = new Map<string, RulesetSnapshot>();
  private readonly loading = new Map<string, Promise<RulesetSnapshot | null>>();
  private readonly servers = new Map<string, Set<Subscriber>>();
  private readonly clients = new Map<string, Set<ClientSubscriber>>();
  private readonly queues = new Map<string, Promise<void>>();
  private nextId = 1;
  private heartbeat: NodeJS.Timeout | null = null;
  private versionCheck: NodeJS.Timeout | null = null;

  constructor(private readonly source: RelaySource) {}

  start(heartbeatMs: number, versionCheckMs: number): void {
    this.heartbeat = setInterval(() => this.sendHeartbeat(), heartbeatMs);
    this.heartbeat.unref();
    this.versionCheck = setInterval(() => void this.checkVersions().catch(() => undefined), versionCheckMs);
    this.versionCheck.unref();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.versionCheck) clearInterval(this.versionCheck);
    for (const set of [...this.servers.values(), ...this.clients.values()]) {
      for (const sub of set) sub.res.end();
    }
    this.servers.clear();
    this.clients.clear();
  }

  async snapshot(envId: string): Promise<RulesetSnapshot | null> {
    const cached = this.cache.get(envId);
    if (cached) return cached;
    return this.load(envId);
  }

  private load(envId: string): Promise<RulesetSnapshot | null> {
    const pending = this.loading.get(envId);
    if (pending) return pending;
    const promise = this.source
      .loadRuleset(envId)
      .then((snapshot) => {
        this.metrics.reloads++;
        if (snapshot) {
          const current = this.cache.get(envId);
          if (!current || current.version <= snapshot.version) this.cache.set(envId, snapshot);
        }
        return this.cache.get(envId) ?? snapshot;
      })
      .finally(() => this.loading.delete(envId));
    this.loading.set(envId, promise);
    return promise;
  }

  addServer(envId: string, res: ServerResponse, snapshot: RulesetSnapshot): Subscriber {
    const sub: Subscriber = { id: this.nextId++, envId, res };
    const set = this.servers.get(envId) ?? new Set();
    set.add(sub);
    this.servers.set(envId, set);
    this.metrics.serverConnections++;
    writeEvent(res, 'put', { version: snapshot.version, ruleset: snapshot.ruleset });
    this.metrics.putsSent++;
    res.on('close', () => {
      if (set.delete(sub)) this.metrics.serverConnections--;
    });
    return sub;
  }

  addClient(
    envId: string,
    res: ServerResponse,
    context: Context,
    withReasons: boolean,
    snapshot: RulesetSnapshot,
  ): ClientSubscriber {
    const flags = clientFlags(snapshot, context, withReasons);
    const sub: ClientSubscriber = { id: this.nextId++, envId, res, context, withReasons, last: flags };
    const set = this.clients.get(envId) ?? new Set();
    set.add(sub);
    this.clients.set(envId, set);
    this.metrics.clientConnections++;
    writeEvent(res, 'put', { version: snapshot.version, flags });
    this.metrics.putsSent++;
    res.on('close', () => {
      if (set.delete(sub)) this.metrics.clientConnections--;
    });
    return sub;
  }

  hasInterest(envId: string): boolean {
    return (
      this.cache.has(envId) ||
      (this.servers.get(envId)?.size ?? 0) > 0 ||
      (this.clients.get(envId)?.size ?? 0) > 0
    );
  }

  handleNotification(notification: ChangeNotification): Promise<void> {
    if (!this.hasInterest(notification.envId)) return Promise.resolve();
    const previous = this.queues.get(notification.envId) ?? Promise.resolve();
    const next = previous.then(() => this.apply(notification)).catch(() => undefined);
    this.queues.set(notification.envId, next);
    return next;
  }

  private async apply(notification: ChangeNotification): Promise<void> {
    const envId = notification.envId;
    const current = this.cache.get(envId);
    if (current && current.version >= notification.envVersion) return;
    this.cache.delete(envId);
    const snapshot = await this.load(envId);
    if (!snapshot) return;
    const exact =
      current !== undefined &&
      current.version + 1 === notification.envVersion &&
      snapshot.version === notification.envVersion;
    if (!exact) {
      this.broadcastServer(envId, 'put', { version: snapshot.version, ruleset: snapshot.ruleset });
    } else if (notification.type === 'flag.changed' && notification.flagKey) {
      this.broadcastServer(envId, 'patch', {
        kind: 'flag',
        key: notification.flagKey,
        version: snapshot.version,
        data: snapshot.ruleset.flags[notification.flagKey] ?? null,
      });
    } else if (notification.type === 'segment.changed' && notification.segmentKey) {
      this.broadcastServer(envId, 'patch', {
        kind: 'segment',
        key: notification.segmentKey,
        version: snapshot.version,
        data: snapshot.ruleset.segments[notification.segmentKey] ?? null,
      });
    } else {
      this.broadcastServer(envId, 'put', { version: snapshot.version, ruleset: snapshot.ruleset });
    }
    this.refreshClients(envId, snapshot);
    const at = Date.parse(notification.at);
    if (!Number.isNaN(at)) this.metrics.lastPatchLatencyMs = Date.now() - at;
  }

  private broadcastServer(envId: string, event: 'put' | 'patch', data: unknown): void {
    const set = this.servers.get(envId);
    if (!set) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const sub of set) {
      if (sub.res.writableEnded || sub.res.destroyed) continue;
      sub.res.write(payload);
      if (event === 'patch') this.metrics.patchesSent++;
      else this.metrics.putsSent++;
    }
  }

  private refreshClients(envId: string, snapshot: RulesetSnapshot): void {
    const set = this.clients.get(envId);
    if (!set) return;
    for (const sub of set) {
      const next = clientFlags(snapshot, sub.context, sub.withReasons);
      const changed: Record<string, FlagState | null> = {};
      let count = 0;
      for (const [key, state] of Object.entries(next)) {
        if (JSON.stringify(sub.last[key]) !== JSON.stringify(state)) {
          changed[key] = state;
          count++;
        }
      }
      for (const key of Object.keys(sub.last)) {
        if (!(key in next)) {
          changed[key] = null;
          count++;
        }
      }
      sub.last = next;
      if (count > 0) {
        writeEvent(sub.res, 'patch', { version: snapshot.version, flags: changed });
        this.metrics.patchesSent++;
      }
    }
  }

  private sendHeartbeat(): void {
    for (const set of [...this.servers.values(), ...this.clients.values()]) {
      for (const sub of set) if (!sub.res.writableEnded) sub.res.write(':heartbeat\n\n');
    }
  }

  async checkVersions(): Promise<void> {
    const envIds = [...new Set([...this.cache.keys(), ...this.servers.keys(), ...this.clients.keys()])];
    const versions = await this.source.currentVersions(envIds);
    for (const [envId, version] of versions) {
      const cached = this.cache.get(envId);
      if (cached && cached.version >= version) continue;
      await this.handleNotification({
        type: 'env.changed',
        envId,
        envKey: cached?.envKey ?? '',
        projectId: '',
        projectKey: '',
        version,
        envVersion: version,
        at: new Date().toISOString(),
      });
    }
  }
}
