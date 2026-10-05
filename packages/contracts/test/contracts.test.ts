import { describe, expect, it } from 'vitest';
import { vectorFiles } from '@ffp/conformance';
import type { FlagWithConfig, Segment } from '@ashamrai/flags-evaluator';
import {
  applyInstructions,
  contextSchema,
  describeInstruction,
  flagSchema,
  instructionListSchema,
  instructionsBetween,
  jsonDiff,
  PatchError,
  rulesetSchema,
  serveSchema,
  type FlagConfig,
  type RulesetFlag,
} from '../src';

const flag = {
  variations: [
    { id: 'on', value: true },
    { id: 'off', value: false },
  ],
};
const base: FlagConfig = {
  flagKey: 'f',
  env: 'production',
  on: false,
  offVariation: 'off',
  targets: [],
  rules: [],
  fallthrough: { variation: 'off' },
  version: 1,
  updatedAt: new Date(0).toISOString(),
};

describe('schemas', () => {
  it('accepts valid flags and rejects bad keys', () => {
    expect(
      flagSchema.safeParse({
        key: 'new-checkout',
        name: 'x',
        kind: 'boolean',
        variations: flag.variations,
        salt: 's',
      }).success,
    ).toBe(true);
    expect(
      flagSchema.safeParse({ key: 'New', name: 'x', kind: 'boolean', variations: flag.variations, salt: 's' })
        .success,
    ).toBe(false);
  });

  it('requires rollout weights to sum to 100000', () => {
    expect(
      serveSchema.safeParse({
        rollout: {
          weights: [
            { variation: 'on', weight: 50000 },
            { variation: 'off', weight: 50000 },
          ],
        },
      }).success,
    ).toBe(true);
    expect(serveSchema.safeParse({ rollout: { weights: [{ variation: 'on', weight: 5 }] } }).success).toBe(
      false,
    );
  });

  it('validates contexts', () => {
    expect(contextSchema.safeParse({ kind: 'user', key: 'u' }).success).toBe(true);
    expect(
      contextSchema.safeParse({ kind: 'multi', user: { key: 'u' }, organization: { key: 'o' } }).success,
    ).toBe(true);
    expect(contextSchema.safeParse({ kind: 'multi' }).success).toBe(false);
    expect(contextSchema.safeParse({ kind: 'user' }).success).toBe(false);
  });

  it('is structurally compatible with evaluator types', () => {
    const parsed: RulesetFlag = rulesetSchema.parse({
      version: 1,
      flags: {
        f: {
          key: 'f',
          name: 'F',
          kind: 'boolean',
          variations: flag.variations,
          salt: 's',
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
    }).flags.f!;
    const asEvaluator: FlagWithConfig = parsed as FlagWithConfig;
    expect(asEvaluator.key).toBe('f');
    const segment: Segment = { key: 's', included: [], excluded: [], rules: [], version: 1 };
    expect(segment.key).toBe('s');
  });

  it('accepts the conformance segments and valid rollouts', () => {
    for (const file of vectorFiles) {
      for (const segment of file.segments) {
        expect(
          rulesetSchema.shape.segments.safeParse({ [segment.key]: { name: segment.key, ...segment } })
            .success,
        ).toBe(true);
      }
    }
  });
});

describe('semantic patch', () => {
  it('applies a list of instructions atomically and immutably', () => {
    const instructions = instructionListSchema.parse([
      { kind: 'turnOn' },
      {
        kind: 'addRule',
        rule: {
          id: 'r1',
          clauses: [{ attribute: 'country', op: 'in', values: ['DE'] }],
          serve: { variation: 'on' },
        },
      },
      { kind: 'addRule', rule: { id: 'r0', clauses: [], serve: { variation: 'off' } }, beforeRuleId: 'r1' },
      { kind: 'addTargets', variationId: 'on', keys: ['alice', 'bob'] },
      { kind: 'addTargets', variationId: 'off', keys: ['bob'] },
      {
        kind: 'updateFallthrough',
        serve: {
          rollout: {
            weights: [
              { variation: 'on', weight: 25000 },
              { variation: 'off', weight: 75000 },
            ],
          },
        },
      },
    ]);
    const next = applyInstructions(base, instructions, flag);
    expect(base.on).toBe(false);
    expect(next.on).toBe(true);
    expect(next.rules.map((r) => r.id)).toEqual(['r0', 'r1']);
    expect(next.targets).toEqual([
      { variation: 'on', contextKind: 'user', keys: ['alice'] },
      { variation: 'off', contextKind: 'user', keys: ['bob'] },
    ]);
    const reordered = applyInstructions(
      next,
      instructionListSchema.parse([
        { kind: 'reorderRules', ruleIds: ['r1', 'r0'] },
        { kind: 'updateRuleClauses', ruleId: 'r1', clauses: [] },
        { kind: 'addClauses', ruleId: 'r1', clauses: [{ attribute: 'plan', op: 'eq', values: ['pro'] }] },
        { kind: 'updateRuleServe', ruleId: 'r0', serve: { variation: 'on' } },
        { kind: 'updateRuleDescription', ruleId: 'r0', description: 'all' },
        { kind: 'removeTargets', variationId: 'off', keys: ['bob'] },
        { kind: 'updateOffVariation', variationId: null },
        { kind: 'removeRule', ruleId: 'r0' },
        { kind: 'turnOff' },
      ]),
      flag,
    );
    expect(reordered.rules).toEqual([
      { id: 'r1', clauses: [{ attribute: 'plan', op: 'eq', values: ['pro'] }], serve: { variation: 'on' } },
    ]);
    expect(reordered.targets).toEqual([{ variation: 'on', contextKind: 'user', keys: ['alice'] }]);
    expect(reordered.offVariation).toBeNull();
    expect(reordered.on).toBe(false);
  });

  it('rejects invalid instructions with the failing index', () => {
    const cases: unknown[][] = [
      [{ kind: 'removeRule', ruleId: 'nope' }],
      [{ kind: 'updateFallthrough', serve: { variation: 'ghost' } }],
      [{ kind: 'turnOn' }, { kind: 'reorderRules', ruleIds: ['x'] }],
      [{ kind: 'addTargets', variationId: 'ghost', keys: ['a'] }],
      [{ kind: 'removeTargets', variationId: 'on', keys: ['a'] }],
      [{ kind: 'updateOffVariation', variationId: 'ghost' }],
      [{ kind: 'replaceTargets', targets: [{ variation: 'ghost', keys: ['a'] }] }],
      [{ kind: 'addRule', rule: { id: 'a', clauses: [], serve: { variation: 'on' } }, beforeRuleId: 'zzz' }],
      [
        { kind: 'addRule', rule: { id: 'a', clauses: [], serve: { variation: 'on' } } },
        { kind: 'addRule', rule: { id: 'a', clauses: [], serve: { variation: 'on' } } },
      ],
    ];
    for (const list of cases) {
      expect(() => applyInstructions(base, instructionListSchema.parse(list), flag)).toThrow(PatchError);
    }
    try {
      applyInstructions(
        base,
        instructionListSchema.parse([{ kind: 'turnOn' }, { kind: 'removeRule', ruleId: 'x' }]),
        flag,
      );
    } catch (error) {
      expect((error as PatchError).index).toBe(1);
    }
  });

  it('describes intent for the audit log', () => {
    const [addRule] = instructionListSchema.parse([
      {
        kind: 'addRule',
        rule: {
          id: 'r',
          clauses: [{ attribute: 'country', op: 'in', values: ['DE'] }],
          serve: { variation: 'on' },
        },
      },
    ]);
    expect(describeInstruction(addRule!, flag)).toBe('added rule: country in [DE] → true');
    const all = instructionListSchema.parse([
      { kind: 'turnOn' },
      { kind: 'turnOff' },
      { kind: 'removeRule', ruleId: 'r' },
      {
        kind: 'updateRuleClauses',
        ruleId: 'r',
        clauses: [{ attribute: 'segment', op: 'segment_match', values: ['beta'], negate: true }],
      },
      {
        kind: 'addClauses',
        ruleId: 'r',
        clauses: [{ attribute: 'tier', contextKind: 'organization', op: 'eq', values: [1] }],
      },
      {
        kind: 'updateRuleServe',
        ruleId: 'r',
        serve: {
          rollout: {
            bucketBy: 'org',
            contextKind: 'organization',
            weights: [
              { variation: 'on', weight: 12345 },
              { variation: 'off', weight: 87655 },
            ],
          },
        },
      },
      { kind: 'updateRuleDescription', ruleId: 'r', description: 'd' },
      { kind: 'reorderRules', ruleIds: ['a', 'b'] },
      { kind: 'updateFallthrough', serve: { variation: 'off' } },
      { kind: 'updateOffVariation', variationId: null },
      { kind: 'addTargets', variationId: 'on', keys: ['a'] },
      { kind: 'removeTargets', variationId: 'on', keys: ['a'] },
      { kind: 'replaceTargets', targets: [{ variation: 'on', keys: ['a', 'b'] }] },
    ]);
    const texts = all.map((i) => describeInstruction(i, flag));
    expect(texts).toContain('default rule now serves false');
    expect(texts.join('\n')).toContain('rollout by org (organization) true 12.345% / false 87.655%');
    expect(texts.join('\n')).toContain('not in segment [beta]');
    expect(texts.every((t) => t.length > 0)).toBe(true);
  });

  it('derives instructions between two configs that reproduce the target', () => {
    const after = applyInstructions(
      base,
      instructionListSchema.parse([
        { kind: 'turnOn' },
        { kind: 'addRule', rule: { id: 'a', clauses: [], serve: { variation: 'on' } } },
        { kind: 'addRule', rule: { id: 'b', clauses: [], serve: { variation: 'off' } } },
        { kind: 'addTargets', variationId: 'on', keys: ['x'] },
      ]),
      flag,
    );
    const changed = applyInstructions(
      after,
      instructionListSchema.parse([
        { kind: 'reorderRules', ruleIds: ['b', 'a'] },
        { kind: 'updateRuleServe', ruleId: 'a', serve: { variation: 'off' } },
        { kind: 'updateRuleDescription', ruleId: 'b', description: 'x' },
        { kind: 'updateRuleClauses', ruleId: 'b', clauses: [{ attribute: 'k', op: 'eq', values: [1] }] },
        { kind: 'updateOffVariation', variationId: 'on' },
        { kind: 'updateFallthrough', serve: { variation: 'on' } },
      ]),
      flag,
    );
    for (const [from, to] of [
      [base, after],
      [after, changed],
      [changed, base],
    ] as const) {
      const derived = instructionsBetween(from, to);
      const rebuilt = applyInstructions(from, derived, flag);
      expect(JSON.stringify({ ...rebuilt, version: 0 })).toBe(JSON.stringify({ ...to, version: 0 }));
    }
  });
});

describe('jsonDiff', () => {
  it('reports changes, id-keyed arrays and order', () => {
    const diff = jsonDiff(
      {
        on: false,
        rules: [
          { id: 'a', x: 1 },
          { id: 'b', x: 2 },
        ],
        list: [1, 2],
      },
      { on: true, rules: [{ id: 'b', x: 3 }, { id: 'a', x: 1 }, { id: 'c' }], list: [1], extra: 1 },
    );
    expect(diff).toEqual([
      { path: '/extra', op: 'added', after: 1 },
      { path: '/list[1]', op: 'removed', before: 2 },
      { path: '/on', op: 'changed', before: false, after: true },
      { path: '/rules[id=b]/x', op: 'changed', before: 2, after: 3 },
      { path: '/rules[id=c]', op: 'added', after: { id: 'c' } },
      { path: '/rules#order', op: 'changed', before: ['a', 'b'], after: ['b', 'a'] },
    ]);
    expect(jsonDiff(1, 1)).toEqual([]);
    expect(jsonDiff(undefined, 1)).toEqual([{ path: '/', op: 'added', after: 1 }]);
  });
});
