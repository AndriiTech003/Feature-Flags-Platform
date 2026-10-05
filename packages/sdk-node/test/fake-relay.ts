import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Ruleset } from '../src';

export type StreamMode = 'normal' | 'broken' | 'silent' | 'error500';

export class FakeRelay {
  ruleset: Ruleset;
  mode: StreamMode = 'normal';
  delayMs = 0;
  streamConnections = 0;
  rulesetRequests = 0;
  notModified = 0;
  events: unknown[] = [];
  throttle = { stream: 0, ruleset: 0, events: 0 };
  retryAfter = '1';
  log: Array<{ path: string; status: number; at: number }> = [];
  private server: Server | null = null;
  private readonly streams = new Set<ServerResponse>();
  port = 0;

  constructor(ruleset: Ruleset) {
    this.ruleset = ruleset;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const res of this.streams) res.destroy();
    this.streams.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  patchFlag(key: string, update: (flag: Ruleset['flags'][string]) => void): void {
    const flag = structuredClone(this.ruleset.flags[key]!);
    update(flag);
    flag.config.version++;
    this.ruleset = {
      ...this.ruleset,
      version: this.ruleset.version + 1,
      flags: { ...this.ruleset.flags, [key]: flag },
    };
    for (const res of this.streams)
      res.write(
        `event: patch\ndata: ${JSON.stringify({ kind: 'flag', key, version: this.ruleset.version, data: flag })}\n\n`,
      );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (req.headers.authorization !== 'srv-test') {
      res.writeHead(401).end();
      return;
    }
    const path = (req.url ?? '').split('?')[0]!;
    const bucket = path.endsWith('/stream') ? 'stream' : path.endsWith('/ruleset') ? 'ruleset' : 'events';
    if (this.throttle[bucket] > 0) {
      this.throttle[bucket]--;
      this.log.push({ path, status: 429, at: Date.now() });
      res.writeHead(429, { 'retry-after': this.retryAfter, 'content-type': 'application/json' });
      res.end('{"error":"rate limit exceeded"}');
      return;
    }
    this.log.push({ path, status: 200, at: Date.now() });
    if (req.url === '/sdk/v1/ruleset') {
      this.rulesetRequests++;
      if (this.mode === 'error500') {
        res.writeHead(500).end();
        return;
      }
      const etag = `"${this.ruleset.version}"`;
      if (req.headers['if-none-match'] === etag) {
        this.notModified++;
        res.writeHead(304, { etag }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag }).end(JSON.stringify(this.ruleset));
      return;
    }
    if (req.url === '/sdk/v1/stream') {
      this.streamConnections++;
      if (this.mode === 'error500') {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      this.streams.add(res);
      res.on('close', () => this.streams.delete(res));
      if (this.mode === 'broken') {
        res.write('event: put\ndata: {"ruleset": {broken json\n\n');
        return;
      }
      if (this.mode === 'silent') return;
      res.write(
        `event: put\ndata: ${JSON.stringify({ version: this.ruleset.version, ruleset: this.ruleset })}\n\n`,
      );
      return;
    }
    if (req.url === '/sdk/v1/events' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body) as { events: unknown[] };
      this.events.push(...parsed.events);
      res.writeHead(202).end('{}');
      return;
    }
    res.writeHead(404).end();
  }
}

export function sampleRuleset(): Ruleset {
  return {
    version: 1,
    flags: {
      'new-checkout': {
        key: 'new-checkout',
        kind: 'boolean',
        salt: 'abc',
        clientSideAvailable: true,
        variations: [
          { id: 'on', value: true },
          { id: 'off', value: false },
        ],
        config: {
          on: true,
          offVariation: 'off',
          targets: [],
          rules: [
            {
              id: 'pro',
              clauses: [{ attribute: 'plan', op: 'eq', values: ['pro'] }],
              serve: { variation: 'on' },
            },
          ],
          fallthrough: { variation: 'off' },
          version: 1,
        },
      },
      'banner-text': {
        key: 'banner-text',
        kind: 'string',
        salt: 'b',
        variations: [
          { id: 'A', value: 'Welcome' },
          { id: 'B', value: 'Sale' },
        ],
        config: {
          on: true,
          offVariation: 'A',
          targets: [],
          rules: [],
          fallthrough: {
            rollout: {
              weights: [
                { variation: 'A', weight: 50000 },
                { variation: 'B', weight: 50000 },
              ],
            },
          },
          version: 1,
          experiment: { id: 'exp' },
        },
      },
    },
    segments: {},
  };
}

export async function waitFor(condition: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
