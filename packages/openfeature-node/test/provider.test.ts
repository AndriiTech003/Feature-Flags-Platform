import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode, OpenFeature, ProviderEvents, StandardResolutionReasons } from '@openfeature/server-sdk';
import { init, silentLogger, type Ruleset } from '@ashamrai/flags-node';
import { FlagsProvider, toFlagsContext } from '../src';
import { FakeRelay, sampleRuleset, waitFor } from '../../sdk-node/test/fake-relay';

const relays: FakeRelay[] = [];

afterEach(async () => {
  await OpenFeature.close();
  await Promise.all(relays.splice(0).map((r) => r.stop()));
});

function ruleset(): Ruleset {
  const base = sampleRuleset();
  base.flags.layout = {
    key: 'layout',
    kind: 'json',
    salt: 'l',
    variations: [
      { id: 'grid', value: { columns: 3 } },
      { id: 'scalar', value: 5 },
    ],
    config: {
      on: true,
      offVariation: 'grid',
      targets: [{ variation: 'scalar', contextKind: 'organization', keys: ['acme'] }],
      rules: [],
      fallthrough: { variation: 'grid' },
      version: 1,
    },
  };
  base.flags.disabled = {
    ...base.flags['new-checkout']!,
    key: 'disabled',
    config: { ...base.flags['new-checkout']!.config, on: false },
  };
  return base;
}

describe('OpenFeature server provider', () => {
  it('maps evaluation context to flags contexts', () => {
    expect(toFlagsContext({ targetingKey: 'u1', plan: 'pro' })).toEqual({
      kind: 'user',
      key: 'u1',
      plan: 'pro',
    });
    expect(toFlagsContext({ targetingKey: 'acme', kind: 'organization', tier: 'gold' })).toEqual({
      kind: 'organization',
      key: 'acme',
      tier: 'gold',
    });
    expect(
      toFlagsContext({ targetingKey: 'u1', plan: 'pro', organization: { key: 'acme', tier: 'gold' } }),
    ).toEqual({
      kind: 'multi',
      user: { key: 'u1', plan: 'pro' },
      organization: { key: 'acme', tier: 'gold' },
    });
    const date = new Date('2025-01-01T00:00:00Z');
    expect(toFlagsContext({ targetingKey: 'u', createdAt: date })).toEqual({
      kind: 'user',
      key: 'u',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('resolves values with standard reasons, variants and error codes', async () => {
    await OpenFeature.setProviderAndWait(
      new FlagsProvider(init({ sdkKey: 'srv', offline: true, bootstrap: ruleset(), logger: silentLogger })),
    );
    const client = OpenFeature.getClient();
    const rule = await client.getBooleanDetails('new-checkout', false, { targetingKey: 'u1', plan: 'pro' });
    expect(rule).toMatchObject({
      value: true,
      variant: 'on',
      reason: StandardResolutionReasons.TARGETING_MATCH,
      flagMetadata: { reasonKind: 'RULE_MATCH', ruleId: 'pro' },
    });
    const fallthrough = await client.getBooleanDetails('new-checkout', true, { targetingKey: 'u1' });
    expect(fallthrough).toMatchObject({
      value: false,
      variant: 'off',
      reason: StandardResolutionReasons.DEFAULT,
    });
    const split = await client.getStringDetails('banner-text', 'x', { targetingKey: 'u1' });
    expect(split.reason).toBe(StandardResolutionReasons.SPLIT);
    expect(split.flagMetadata.inExperiment).toBe(true);
    expect((await client.getBooleanDetails('disabled', true, { targetingKey: 'u1' })).reason).toBe(
      StandardResolutionReasons.DISABLED,
    );
    const missing = await client.getBooleanDetails('nope', true, { targetingKey: 'u1' });
    expect(missing).toMatchObject({
      value: true,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.FLAG_NOT_FOUND,
    });
    const mismatch = await client.getNumberDetails('banner-text', 7, { targetingKey: 'u1' });
    expect(mismatch).toMatchObject({ value: 7, errorCode: ErrorCode.TYPE_MISMATCH });
    expect(await client.getObjectValue('layout', {}, { targetingKey: 'u1' })).toEqual({ columns: 3 });
    const scalar = await client.getObjectDetails(
      'layout',
      { fallback: true },
      { targetingKey: 'u1', organization: { key: 'acme' } },
    );
    expect(scalar).toMatchObject({ value: { fallback: true }, errorCode: ErrorCode.TYPE_MISMATCH });
    const noKey = await client.getBooleanDetails('new-checkout', true, {});
    expect(noKey.errorCode).toBe(ErrorCode.TARGETING_KEY_MISSING);
  });

  it('emits ready, configuration changed and stale events, and forwards tracking', async () => {
    const relay = new FakeRelay(sampleRuleset());
    relays.push(relay);
    await relay.start();
    const provider = new FlagsProvider({
      sdkKey: 'srv-test',
      baseUrl: relay.url,
      logger: silentLogger,
      streamInitialRetryMs: 50,
      streamMaxRetryMs: 100,
      pollIntervalMs: 60000,
      events: { flushIntervalMs: 60000 },
    });
    const seen: string[] = [];
    OpenFeature.addHandler(ProviderEvents.Ready, () => seen.push('ready'));
    OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, (d) =>
      seen.push(`changed:${((d as { flagsChanged?: string[] } | undefined)?.flagsChanged ?? []).join(',')}`),
    );
    OpenFeature.addHandler(ProviderEvents.Stale, () => seen.push('stale'));
    await OpenFeature.setProviderAndWait(provider);
    expect(seen).toContain('ready');
    const client = OpenFeature.getClient();
    expect(await client.getBooleanValue('new-checkout', false, { targetingKey: 'u1', plan: 'pro' })).toBe(
      true,
    );
    relay.patchFlag('new-checkout', (flag) => {
      flag.config.on = false;
    });
    await waitFor(() => seen.includes('changed:new-checkout'));
    expect(await client.getBooleanValue('new-checkout', true, { targetingKey: 'u1', plan: 'pro' })).toBe(
      false,
    );
    client.track('purchase', { targetingKey: 'u1' }, { value: 42, currency: 'USD' });
    await provider.client.flush();
    const purchase = relay.events.find((e) => (e as { kind: string }).kind === 'custom') as {
      key: string;
      value: number;
      data: unknown;
    };
    expect(purchase).toMatchObject({ key: 'purchase', value: 42, data: { currency: 'USD' } });
    await relay.stop();
    await waitFor(() => seen.includes('stale'));
  });

  it('reports a provider error when initialization fails', async () => {
    const provider = new FlagsProvider({
      sdkKey: 'srv-test',
      baseUrl: 'http://127.0.0.1:9',
      logger: silentLogger,
      initializationTimeoutMs: 100,
      events: { enabled: false },
    });
    const errors: string[] = [];
    OpenFeature.addHandler(ProviderEvents.Error, () => errors.push('error'));
    await expect(OpenFeature.setProviderAndWait(provider)).rejects.toBeDefined();
    expect(errors).toEqual(['error']);
    expect(await OpenFeature.getClient().getBooleanValue('new-checkout', true, { targetingKey: 'u' })).toBe(
      true,
    );
  });
});
