import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  canonicalContextKey,
  compileRegex,
  contextKinds,
  createStore,
  evaluate,
  evaluateAll,
  evaluateFlag,
  type FlagWithConfig,
  type Ruleset,
} from '../src';

function flag(
  key: string,
  overrides: Partial<FlagWithConfig['config']> = {},
  extra: Partial<FlagWithConfig> = {},
): FlagWithConfig {
  return {
    key,
    kind: 'boolean',
    salt: 'salt',
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
      version: 4,
      ...overrides,
    },
    ...extra,
  };
}

describe('evaluate', () => {
  const ruleset: Ruleset = {
    version: 1,
    flags: {
      a: flag('a', {}, { clientSideAvailable: true }),
      b: flag('b', { on: false }),
      c: flag(
        'c',
        {
          fallthrough: { rollout: { weights: [{ variation: 'on', weight: 100000 }] } },
          experiment: { id: 'e' },
        },
        { clientSideAvailable: true },
      ),
      archived: flag('archived', {}, { archivedAt: '2025-01-01T00:00:00Z' }),
    },
    segments: {},
  };
  const store = createStore(ruleset);

  it('evaluates all flags with and without reasons', () => {
    const all = evaluateAll(
      Object.values(ruleset.flags),
      store,
      { kind: 'user', key: 'u' },
      { withReasons: true },
    );
    expect(Object.keys(all).sort()).toEqual(['a', 'b', 'c']);
    expect(all.a).toEqual({ value: true, variationId: 'on', version: 4, reason: { kind: 'FALLTHROUGH' } });
    expect(all.c!.inExperiment).toBe(true);
    const client = evaluateAll(
      Object.values(ruleset.flags),
      store,
      { kind: 'user', key: 'u' },
      { clientSideOnly: true },
    );
    expect(Object.keys(client).sort()).toEqual(['a', 'c']);
    expect(client.a!.reason).toBeUndefined();
  });

  it('does not resolve prototype keys as flags', () => {
    expect(evaluateFlag(store, 'toString', { kind: 'user', key: 'u' }, { defaultValue: 1 }).reason).toEqual({
      kind: 'ERROR',
      errorKind: 'FLAG_NOT_FOUND',
    });
    expect(store.getSegment('constructor')).toBeUndefined();
  });

  it('returns EXCEPTION when the store throws', () => {
    const broken = {
      getFlag: () => {
        throw new Error('boom');
      },
      getSegment: () => undefined,
    };
    expect(evaluateFlag(broken, 'x', { kind: 'user', key: 'u' }, { defaultValue: 'd' })).toEqual({
      value: 'd',
      variationId: null,
      reason: { kind: 'ERROR', errorKind: 'EXCEPTION' },
    });
    const throwingSegments = {
      getFlag: () => undefined,
      getSegment: () => {
        throw new Error('segment');
      },
    };
    const f = flag('s', {
      rules: [
        {
          id: 'r',
          clauses: [{ attribute: 'segment', op: 'segment_match', values: ['x'] }],
          serve: { variation: 'off' },
        },
      ],
    });
    expect(
      evaluate(f, f.config, { kind: 'user', key: 'u' }, throwingSegments, { defaultValue: 0 }).reason,
    ).toEqual({
      kind: 'ERROR',
      errorKind: 'EXCEPTION',
    });
  });

  it('treats malformed structures as MALFORMED_FLAG', () => {
    const bad = flag('bad', { rules: [{ id: 'r', clauses: 'nope' as never, serve: { variation: 'on' } }] });
    expect(evaluate(bad, bad.config, { kind: 'user', key: 'u' }, store).reason).toEqual({
      kind: 'ERROR',
      errorKind: 'MALFORMED_FLAG',
    });
    const noRules = { ...bad, config: { ...bad.config, rules: null as never } };
    expect(evaluate(noRules, noRules.config, { kind: 'user', key: 'u' }, store).reason).toEqual({
      kind: 'ERROR',
      errorKind: 'MALFORMED_FLAG',
    });
    const badClause = flag('bc', {
      rules: [
        {
          id: 'r',
          clauses: [{ attribute: 'x', op: 'in', values: null as never }],
          serve: { variation: 'on' },
        },
      ],
    });
    expect(evaluate(badClause, badClause.config, { kind: 'user', key: 'u' }, store).reason.kind).toBe(
      'ERROR',
    );
    const badWeight = flag('bw', {
      fallthrough: { rollout: { weights: [{ variation: 'on', weight: -1 }] } },
    });
    expect(evaluate(badWeight, badWeight.config, { kind: 'user', key: 'u' }, store).reason).toEqual({
      kind: 'ERROR',
      errorKind: 'MALFORMED_FLAG',
    });
    const unknownOp = flag('uo', {
      rules: [
        {
          id: 'r',
          clauses: [{ attribute: 'key', op: 'weird' as never, values: ['u'] }],
          serve: { variation: 'off' },
        },
      ],
    });
    expect(evaluate(unknownOp, unknownOp.config, { kind: 'user', key: 'u' }, store).variationId).toBe('on');
  });

  it('accepts json kind for any value', () => {
    const f = flag('j');
    expect(evaluate(f, f.config, { kind: 'user', key: 'u' }, store, { expectedKind: 'json' }).value).toBe(
      true,
    );
  });

  it('never throws for arbitrary inputs', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), fc.anything(), (a, b, c) => {
        const result = evaluate(a as never, b as never, c as never, store, { defaultValue: 'd' });
        expect(typeof result.reason.kind).toBe('string');
      }),
      { numRuns: 3000 },
    );
  });

  it('builds canonical keys for contexts', () => {
    expect(canonicalContextKey({ kind: 'multi', user: { key: 'u 1' }, organization: { key: 'o' } })).toBe(
      'organization:o:user:u%201',
    );
    expect(contextKinds({ key: 'x' })).toEqual(['user']);
  });

  it('caches compiled regexes and bounds the cache', () => {
    expect(compileRegex('^a$')).toBe(compileRegex('^a$'));
    for (let i = 0; i < 600; i++) compileRegex(`^x${i}$`);
    expect(compileRegex('^a$')!.test('a')).toBe(true);
    expect(compileRegex('(a)\\1')).toBeNull();
  });
});
