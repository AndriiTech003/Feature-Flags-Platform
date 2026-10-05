import { describe, expect, it } from 'vitest';
import { init, silentLogger } from '../src';
import { DataStore } from '../src/store';
import { sampleRuleset } from './fake-relay';

const gc = (globalThis as { gc?: () => void }).gc;

describe('resource usage', () => {
  it('keeps heap stable over 1M evaluations and 1000 patches', async () => {
    expect(gc).toBeTypeOf('function');
    const client = init({ sdkKey: 'srv', offline: true, bootstrap: sampleRuleset(), logger: silentLogger });
    const store = (client as unknown as { data: DataStore }).data;
    const run = (iterations: number, patches: number) => {
      for (let i = 0; i < iterations; i++) {
        client.boolVariation(
          'new-checkout',
          { kind: 'user', key: `user-${i % 5000}`, plan: i % 2 ? 'pro' : 'free' },
          false,
        );
        client.stringVariation('banner-text', { kind: 'user', key: `user-${i % 5000}` }, 'x');
        if (patches > 0 && i % Math.floor(iterations / patches) === 0) {
          const flag = structuredClone(store.snapshot().flags['new-checkout']!);
          flag.config.version++;
          store.applyPatch({ kind: 'flag', key: 'new-checkout', version: store.version + 1, data: flag });
        }
      }
    };
    run(100000, 100);
    gc!();
    const before = process.memoryUsage().heapUsed;
    run(1000000, 1000);
    gc!();
    await new Promise((r) => setTimeout(r, 50));
    gc!();
    const after = process.memoryUsage().heapUsed;
    expect(store.version).toBeGreaterThanOrEqual(1100);
    expect((after - before) / 1024 / 1024).toBeLessThan(10);
    await client.close();
  }, 120000);
});
