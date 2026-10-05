import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestProject } from 'vitest/node';
import { vectorFiles, rulesetFromVector } from '@ffp/conformance';
import { createRelay, loadRelayConfig, MemorySource } from '@ffp/relay';
import type { Ruleset } from '@ashamrai/flags-evaluator';

declare module 'vitest' {
  export interface ProvidedContext {
    relayUrl: string;
    controlUrl: string;
    limitedRelayUrl: string;
  }
}

function liveRuleset(version: number, banner: string): Ruleset {
  return {
    env: 'live',
    version,
    flags: {
      banner: {
        key: 'banner',
        kind: 'string',
        salt: 'x',
        clientSideAvailable: true,
        variations: [
          { id: 'a', value: 'Welcome' },
          { id: 'b', value: 'Sale' },
        ],
        config: {
          on: true,
          offVariation: 'a',
          targets: [],
          rules: [
            {
              id: 'pro',
              clauses: [{ attribute: 'plan', op: 'eq', values: ['pro'] }],
              serve: { variation: 'b' },
            },
          ],
          fallthrough: {
            rollout: {
              weights: [
                { variation: banner, weight: 100000 },
                { variation: banner === 'a' ? 'b' : 'a', weight: 0 },
              ],
            },
          },
          version,
          experiment: { id: 'e' },
        },
      },
      'server-only': {
        key: 'server-only',
        kind: 'boolean',
        salt: 'y',
        clientSideAvailable: false,
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
          version: 1,
        },
      },
    },
    segments: {},
  };
}

export default async function setup(project: TestProject) {
  const source = new MemorySource();
  for (const file of vectorFiles) {
    source.keys.set(`cli-${file.name}`, { envId: file.name, kind: 'client' });
    source.snapshots.set(file.name, {
      envId: file.name,
      envKey: file.name,
      version: 1,
      ruleset: rulesetFromVector(file, { clientSideAvailable: true }) as unknown as Ruleset,
    });
  }
  source.keys.set('cli-live', { envId: 'live', kind: 'client' });
  let version = 1;
  source.snapshots.set('live', {
    envId: 'live',
    envKey: 'live',
    version,
    ruleset: liveRuleset(version, 'a'),
  });
  const defaults = loadRelayConfig({});
  const relay = await createRelay(
    { ...defaults, port: 0, heartbeatMs: 1000, rateLimit: { ...defaults.rateLimit, enabled: false } },
    { source, redis: false },
  );
  const limitedSource = new MemorySource();
  limitedSource.snapshots.set('live', {
    envId: 'live',
    envKey: 'live',
    version: 1,
    ruleset: liveRuleset(1, 'a'),
  });
  const limited = await createRelay(
    {
      ...defaults,
      port: 0,
      heartbeatMs: 1000,
      rateLimit: {
        ...defaults.rateLimit,
        clientKey: { ratePerSecond: 1, burst: 1 },
        ip: { ratePerSecond: 1000, burst: 1000 },
      },
    },
    { source: limitedSource, redis: false },
  );
  const control = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    const match = /^\/live\/(a|b)$/.exec(req.url ?? '');
    if (match) {
      version++;
      source.snapshots.set('live', {
        envId: 'live',
        envKey: 'live',
        version,
        ruleset: liveRuleset(version, match[1]!),
      });
      await relay.hub.handleNotification({
        type: 'flag.changed',
        envId: 'live',
        envKey: 'live',
        projectId: 'p',
        projectKey: 'p',
        flagKey: 'banner',
        version,
        envVersion: version,
        at: new Date().toISOString(),
      });
      return void res.writeHead(200).end('{}');
    }
    const register = /^\/limited\/keys\/([\w-]+)$/.exec(req.url ?? '');
    if (register) {
      limitedSource.keys.set(register[1]!, { envId: 'live', kind: 'client' });
      return void res.writeHead(200).end('{}');
    }
    if (req.url === '/limited/events') {
      return void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(limitedSource.ingested.flatMap((i) => i.batch.events)));
    }
    if (req.url === '/events') {
      return void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(source.ingested.flatMap((i) => i.batch.events)));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
  project.provide('relayUrl', relay.url);
  project.provide('limitedRelayUrl', limited.url);
  project.provide('controlUrl', `http://127.0.0.1:${(control.address() as AddressInfo).port}`);
  return async () => {
    control.close();
    await relay.close();
    await limited.close();
  };
}
