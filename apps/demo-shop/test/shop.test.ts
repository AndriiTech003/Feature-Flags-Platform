import { describe, expect, it } from 'vitest';
import { init } from '@ashamrai/flags-node';
import { createShop } from '../src/server/app';
import { mulberry32 } from '../src/traffic';

const ruleset = {
  version: 1,
  flags: {
    'new-checkout': {
      key: 'new-checkout',
      kind: 'boolean' as const,
      salt: 's',
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
            clauses: [{ attribute: 'plan', op: 'eq' as const, values: ['pro'] }],
            serve: { variation: 'on' },
          },
        ],
        fallthrough: { variation: 'off' },
        version: 1,
      },
    },
    'banner-text': {
      key: 'banner-text',
      kind: 'string' as const,
      salt: 'b',
      clientSideAvailable: true,
      variations: [
        { id: 'A', value: 'Hello <shoppers>' },
        { id: 'B', value: 'Sale' },
      ],
      config: {
        on: true,
        offVariation: 'A',
        targets: [],
        rules: [],
        fallthrough: { variation: 'A' },
        version: 1,
      },
    },
  },
  segments: {},
};

describe('demo-shop', () => {
  it('server-renders with bootstrap values, escapes content and evaluates new-checkout per plan', async () => {
    const flags = init({ sdkKey: 'srv', offline: true, bootstrap: ruleset });
    const { app } = createShop(
      {
        port: 0,
        host: '127.0.0.1',
        relayUrl: 'http://relay',
        publicRelayUrl: 'http://relay',
        serverKey: 'srv',
        clientKey: 'cli',
      },
      flags,
    );
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const html = await (await fetch(`http://127.0.0.1:${port}/?user=u1&plan=pro`)).text();
      expect(html).toContain('Hello &lt;shoppers&gt;');
      expect(html).toContain('One-page checkout');
      expect(html).toContain('"bootstrap":{"flags":{');
      expect(html).not.toContain('<shoppers>');
      const free = (await (
        await fetch(`http://127.0.0.1:${port}/api/checkout?user=u2&plan=free`)
      ).json()) as { checkout: string };
      expect(free.checkout).toBe('classic');
      const page = await (await fetch(`http://127.0.0.1:${port}/checkout?user=u3&plan=pro`)).text();
      expect(page).toContain('data-mode="new"');
      expect(await (await fetch(`http://127.0.0.1:${port}/checkout?user=u4&plan=free`)).text()).toContain(
        'step 1 of 3',
      );
    } finally {
      server.close();
      await flags.close();
    }
  });

  it('uses a deterministic seeded random generator for traffic', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
