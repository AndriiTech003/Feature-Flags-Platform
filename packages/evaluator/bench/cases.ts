import { createStore, type FlagWithConfig, type Ruleset } from '../src';

const bool = [
  { id: 'on', value: true },
  { id: 'off', value: false },
];

function base(key: string, config: Partial<FlagWithConfig['config']>): FlagWithConfig {
  return {
    key,
    kind: 'boolean',
    salt: `${key}-salt`,
    variations: bool,
    config: {
      on: true,
      offVariation: 'off',
      targets: [],
      rules: [],
      fallthrough: { variation: 'off' },
      version: 1,
      ...config,
    },
  };
}

const fiveRules = Array.from({ length: 5 }, (_, i) => ({
  id: `r${i}`,
  clauses: [
    { attribute: 'country', op: 'in' as const, values: ['DE', 'FR', 'PL', i === 4 ? 'UA' : 'XX'] },
    { attribute: 'plan', op: 'eq' as const, values: [i === 4 ? 'pro' : 'enterprise'] },
    { attribute: 'age', op: 'gte' as const, values: [18] },
  ],
  serve: { variation: 'on' },
}));

const included = Array.from({ length: 1000 }, (_, i) => `member-${i}`);

export const ruleset: Ruleset = {
  version: 1,
  flags: {
    off: base('off', { on: false }),
    rules: base('rules', { rules: fiveRules }),
    rollout: base('rollout', {
      fallthrough: {
        rollout: {
          weights: [
            { variation: 'on', weight: 50000 },
            { variation: 'off', weight: 50000 },
          ],
        },
      },
    }),
    segment: base('segment', {
      rules: [
        {
          id: 's',
          clauses: [{ attribute: 'segment', op: 'segment_match', values: ['big'] }],
          serve: { variation: 'on' },
        },
      ],
    }),
    regex: base('regex', {
      rules: [
        {
          id: 'x',
          clauses: [{ attribute: 'email', op: 'matches', values: ['^[a-z0-9.]+@(acme|globex)\\.(io|com)$'] }],
          serve: { variation: 'on' },
        },
      ],
    }),
  },
  segments: { big: { key: 'big', included, excluded: [], rules: [], version: 1 } },
};

export const store = createStore(ruleset);

export const context = {
  kind: 'user',
  key: 'member-777',
  country: 'UA',
  plan: 'pro',
  age: 30,
  email: 'jane.doe@acme.io',
};

export const targets: Record<string, number> = {
  'boolean flag, off': 0.3,
  '5 rules x 3 clauses, match in last': 5,
  'rollout 50/50 (murmurhash)': 1,
  'segment with 1000 included keys': 1,
  'regex clause': 3,
};

export const keysFor: Record<string, string> = {
  'boolean flag, off': 'off',
  '5 rules x 3 clauses, match in last': 'rules',
  'rollout 50/50 (murmurhash)': 'rollout',
  'segment with 1000 included keys': 'segment',
  'regex clause': 'regex',
};
