import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode, OpenFeature, ProviderEvents, StandardResolutionReasons } from '@openfeature/web-sdk';
import { createRelay, loadRelayConfig, MemorySource, type RunningRelay } from '@ffp/relay';
import type { Ruleset } from '@ashamrai/flags-evaluator';
import { WebFlagsProvider } from '../src';

function ruleset(version: number, fallthrough: string): Ruleset {
  return {
    version,
    flags: {
      banner: {
        key: 'banner',
        kind: 'string',
        salt: 's',
        clientSideAvailable: true,
        variations: [
          { id: 'A', value: 'Welcome' },
          { id: 'B', value: 'Sale' },
        ],
        config: {
          on: true,
          offVariation: 'A',
          targets: [],
          rules: [
            {
              id: 'pro',
              clauses: [{ attribute: 'plan', op: 'eq', values: ['pro'] }],
              serve: { variation: 'B' },
            },
          ],
          fallthrough: { variation: fallthrough },
          version,
        },
      },
    },
    segments: {},
  };
}

let relay: RunningRelay;
let source: MemorySource;

beforeAll(async () => {
  source = new MemorySource();
  source.keys.set('cli-of', { envId: 'env', kind: 'client' });
  source.snapshots.set('env', { envId: 'env', envKey: 'production', version: 1, ruleset: ruleset(1, 'A') });
  relay = await createRelay({ ...loadRelayConfig({}), port: 0 }, { source, redis: false });
});

afterAll(async () => {
  await OpenFeature.close();
  await relay.close();
});

describe('OpenFeature web provider', () => {
  it('resolves synchronously from server-evaluated values, re-evaluates on context change and emits configuration changes', async () => {
    const seen: string[] = [];
    OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, (d) =>
      seen.push(`changed:${((d as { flagsChanged?: string[] } | undefined)?.flagsChanged ?? []).join(',')}`),
    );
    await OpenFeature.setContext({ targetingKey: 'visitor-1' });
    await OpenFeature.setProviderAndWait(
      new WebFlagsProvider({
        clientKey: 'cli-of',
        baseUrl: relay.url,
        withReasons: true,
        sendEvents: false,
        storage: null,
      }),
    );
    const client = OpenFeature.getClient();
    expect(client.getStringDetails('banner', 'x')).toMatchObject({
      value: 'Welcome',
      variant: 'A',
      reason: StandardResolutionReasons.DEFAULT,
    });
    expect(client.getBooleanDetails('missing', true)).toMatchObject({
      value: true,
      errorCode: ErrorCode.FLAG_NOT_FOUND,
    });
    expect(client.getNumberDetails('banner', 1)).toMatchObject({
      value: 1,
      errorCode: ErrorCode.TYPE_MISMATCH,
    });
    await OpenFeature.setContext({ targetingKey: 'visitor-1', plan: 'pro' });
    expect(client.getStringDetails('banner', 'x')).toMatchObject({
      value: 'Sale',
      reason: StandardResolutionReasons.TARGETING_MATCH,
    });
    await OpenFeature.setContext({ targetingKey: 'visitor-2' });
    source.snapshots.set('env', { envId: 'env', envKey: 'production', version: 2, ruleset: ruleset(2, 'B') });
    await relay.hub.handleNotification({
      type: 'flag.changed',
      envId: 'env',
      envKey: 'production',
      projectId: 'p',
      projectKey: 'p',
      flagKey: 'banner',
      version: 2,
      envVersion: 2,
      at: new Date().toISOString(),
    });
    const deadline = Date.now() + 3000;
    while (client.getStringValue('banner', 'x') !== 'Sale' && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(client.getStringValue('banner', 'x')).toBe('Sale');
    expect(seen.some((s) => s.includes('banner'))).toBe(true);
  });
});
