import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createStore, evaluateFlag, bucketFor, type FlagWithConfig } from '../src';
import { chiSquarePValue } from './stats';

function rolloutFlag(key: string, salt: string, onWeight: number): FlagWithConfig {
  return {
    key,
    salt,
    kind: 'boolean',
    variations: [
      { id: 'on', value: true },
      { id: 'off', value: false },
    ],
    config: {
      on: true,
      offVariation: 'off',
      targets: [],
      rules: [],
      fallthrough: {
        rollout: {
          weights: [
            { variation: 'on', weight: onWeight },
            { variation: 'off', weight: 100000 - onWeight },
          ],
        },
      },
      version: 1,
    },
  };
}

function randomKeys(count: number, seed: number): string[] {
  let state = seed >>> 0;
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    keys.push(`user-${state.toString(36)}-${i}`);
  }
  return keys;
}

describe('bucketing properties', () => {
  it('is monotonic: raising a rollout from 10% to 20% keeps everyone who was in 10%', () => {
    const keys = randomKeys(100000, 7);
    const store10 = createStore({ flags: { f: rolloutFlag('f', 'salt', 10000) }, segments: {} });
    const store20 = createStore({ flags: { f: rolloutFlag('f', 'salt', 20000) }, segments: {} });
    let in10 = 0;
    let in20 = 0;
    for (const key of keys) {
      const a = evaluateFlag(store10, 'f', { kind: 'user', key }).value;
      const b = evaluateFlag(store20, 'f', { kind: 'user', key }).value;
      if (a) {
        in10++;
        expect(b).toBe(true);
      }
      if (b) in20++;
    }
    expect(in10 / keys.length).toBeGreaterThan(0.095);
    expect(in10 / keys.length).toBeLessThan(0.105);
    expect(in20 / keys.length).toBeGreaterThan(0.195);
    expect(in20 / keys.length).toBeLessThan(0.205);
  });

  it('is monotonic for arbitrary weights and keys', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.integer({ min: 0, max: 100000 }),
        fc.integer({ min: 0, max: 100000 }),
        fc.string({ maxLength: 12 }),
        (key, w1, w2, salt) => {
          const low = Math.min(w1, w2);
          const high = Math.max(w1, w2);
          const a = evaluateFlag(
            createStore({ flags: { f: rolloutFlag('f', salt, low) }, segments: {} }),
            'f',
            { kind: 'user', key },
          );
          const b = evaluateFlag(
            createStore({ flags: { f: rolloutFlag('f', salt, high) }, segments: {} }),
            'f',
            { kind: 'user', key },
          );
          if (a.value === true) expect(b.value).toBe(true);
        },
      ),
      { numRuns: 5000 },
    );
  });

  it('is uniform: chi-square over 1M keys in 100 buckets has p > 0.01', () => {
    const counts = new Array<number>(100).fill(0);
    const total = 1000000;
    for (let i = 0; i < total; i++) {
      const bucket = bucketFor('uniformity', 'salt-1', `key-${i}`);
      counts[Math.floor(bucket / 1000)]!++;
    }
    const expected = total / 100;
    const statistic = counts.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);
    const p = chiSquarePValue(statistic, 99);
    expect(p).toBeGreaterThan(0.01);
  });

  it('is independent across flags with different salts', () => {
    const n = 200000;
    let a = 0;
    let b = 0;
    let both = 0;
    for (let i = 0; i < n; i++) {
      const key = `user-${i}`;
      const inA = bucketFor('flag-a', 'salt-a', key) < 10000 ? 1 : 0;
      const inB = bucketFor('flag-b', 'salt-b', key) < 10000 ? 1 : 0;
      a += inA;
      b += inB;
      both += inA & inB;
    }
    const pa = a / n;
    const pb = b / n;
    const covariance = both / n - pa * pb;
    const correlation = covariance / Math.sqrt(pa * (1 - pa) * pb * (1 - pb));
    expect(Math.abs(correlation)).toBeLessThan(0.01);
    const contingency = [
      [both, a - both],
      [b - both, n - a - b + both],
    ];
    const rows = [a, n - a];
    const cols = [b, n - b];
    let chi = 0;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const e = (rows[r]! * cols[c]!) / n;
        chi += (contingency[r]![c]! - e) ** 2 / e;
      }
    }
    expect(chiSquarePValue(chi, 1)).toBeGreaterThan(0.001);
  });

  it('same key and salt but different flag keys are independent too', () => {
    let same = 0;
    for (let i = 0; i < 50000; i++) {
      if (bucketFor('x', 's', `k${i}`) < 50000 === bucketFor('y', 's', `k${i}`) < 50000) same++;
    }
    expect(Math.abs(same / 50000 - 0.5)).toBeLessThan(0.01);
  });

  it('never throws for arbitrary contexts and rule shapes', () => {
    const clause = fc.record({
      attribute: fc.oneof(fc.string(), fc.constantFrom('key', 'kind', 'a.b', 'segment')),
      contextKind: fc.option(fc.constantFrom('user', 'organization', 'device'), { nil: undefined }),
      op: fc.constantFrom(
        'in',
        'not_in',
        'eq',
        'neq',
        'contains',
        'starts_with',
        'ends_with',
        'matches',
        'lt',
        'lte',
        'gt',
        'gte',
        'semver_eq',
        'semver_lt',
        'semver_gt',
        'before',
        'after',
        'segment_match',
        'bogus',
      ),
      values: fc.array(
        fc.oneof(fc.string(), fc.integer(), fc.double(), fc.boolean(), fc.constant(null), fc.anything()),
        { maxLength: 4 },
      ),
      negate: fc.option(fc.boolean(), { nil: undefined }),
    });
    const serve = fc.oneof(
      fc.record({ variation: fc.constantFrom('on', 'off', 'missing') }),
      fc.record({
        rollout: fc.record({
          bucketBy: fc.option(fc.string(), { nil: undefined }),
          contextKind: fc.option(fc.constantFrom('user', 'organization'), { nil: undefined }),
          weights: fc.array(
            fc.record({
              variation: fc.constantFrom('on', 'off'),
              weight: fc.integer({ min: -10, max: 100000 }),
            }),
            { maxLength: 3 },
          ),
        }),
      }),
      fc.anything(),
    );
    const context = fc.oneof(
      fc.record({ kind: fc.constantFrom('user', 'device'), key: fc.string() }, { requiredKeys: [] }),
      fc.dictionary(fc.string(), fc.anything()),
      fc.record({
        kind: fc.constant('multi'),
        user: fc.record({ key: fc.string() }),
        organization: fc.anything(),
      }),
      fc.anything(),
    );
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.string(), clauses: fc.array(clause, { maxLength: 3 }), serve }), {
          maxLength: 3,
        }),
        serve,
        context,
        (rules, fallthrough, ctx) => {
          const flag = rolloutFlag('p', 's', 50000);
          const config = { ...flag.config, rules: rules as never, fallthrough: fallthrough as never };
          const store = createStore({
            flags: {
              p: { ...flag, config },
              q: { ...flag, key: 'q', prerequisites: [{ flagKey: 'p', variationId: 'on' }] },
            },
            segments: {
              s: {
                key: 's',
                included: ['a'],
                excluded: [],
                rules: [{ clauses: [clause as never] }],
                version: 1,
              },
            } as never,
          });
          for (const key of ['p', 'q']) {
            const result = evaluateFlag(store, key, ctx as never, { defaultValue: 'default' });
            expect([
              'OFF',
              'FALLTHROUGH',
              'RULE_MATCH',
              'TARGET_MATCH',
              'PREREQUISITE_FAILED',
              'ERROR',
            ]).toContain(result.reason.kind);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });
});
