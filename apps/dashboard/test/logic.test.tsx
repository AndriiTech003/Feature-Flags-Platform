import { instructionsBetween } from '@ashamrai/flags-contracts';
import { createStore, evaluate, type FlagWithConfig } from '@ashamrai/flags-evaluator';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatValues, parseValues } from '../src/components/clause-builder';
import { DistributionBar, variationLabel } from '../src/components/serve-editor';
import { explain } from '../src/components/playground';
import type { FlagConfig } from '../src/lib/types';
import { percent, relativeTime } from '../src/lib/utils';

const variations = [
  { id: 'on', value: true, name: 'On' },
  { id: 'off', value: false, name: 'Off' },
];

const flag: FlagWithConfig = {
  key: 'f',
  kind: 'boolean',
  salt: 's',
  variations,
  config: {
    on: true,
    offVariation: 'off',
    targets: [],
    rules: [
      {
        id: 'r1',
        description: 'Pro users',
        clauses: [{ attribute: 'plan', op: 'eq', values: ['pro'] }],
        serve: { variation: 'on' },
      },
    ],
    fallthrough: {
      rollout: {
        weights: [
          { variation: 'on', weight: 25000 },
          { variation: 'off', weight: 75000 },
        ],
      },
    },
    version: 1,
  },
};

const config = flag.config as unknown as FlagConfig;

describe('dashboard logic', () => {
  it('parses clause values by operator', () => {
    expect(parseValues('gt', '10, 2.5, x')).toEqual([10, 2.5, 'x']);
    expect(parseValues('in', 'DE, FR, true')).toEqual(['DE', 'FR', true]);
    expect(formatValues(['DE', 3, true])).toBe('DE, 3, true');
  });

  it('explains evaluation results like the playground', () => {
    const store = createStore({ flags: { f: flag }, segments: {} });
    const match = evaluate(flag, flag.config, { kind: 'user', key: 'u', plan: 'pro' }, store);
    expect(explain(match, config, variations)).toBe(
      'Rule 1 "Pro users" matched (plan eq [pro]) and serves On.',
    );
    const fall = evaluate(flag, flag.config, { kind: 'user', key: 'u' }, store);
    expect(explain(fall, config, variations)).toMatch(
      /No rule matched, the default rule serves rollout On 25% \/ Off 75%/,
    );
    const off = evaluate(flag, { ...flag.config, on: false }, { kind: 'user', key: 'u' }, store);
    expect(explain(off, config, variations)).toMatch(/flag is off/);
  });

  it('turns local draft edits into semantic instructions for the pending changes bar', () => {
    const draft = { ...config, on: false, fallthrough: { variation: 'on' } };
    expect(instructionsBetween(config, draft).map((i) => i.kind)).toEqual(['turnOff', 'updateFallthrough']);
  });

  it('renders the rollout distribution and labels', () => {
    render(
      <DistributionBar
        weights={[
          { variation: 'on', weight: 30000 },
          { variation: 'off', weight: 70000 },
        ]}
        variations={variations}
      />,
    );
    const bar = screen.getByTestId('distribution-bar');
    expect(bar.children).toHaveLength(2);
    expect((bar.children[0] as HTMLElement).style.width).toBe('30%');
    expect(variationLabel(variations, 'off')).toBe('Off');
    expect(variationLabel(variations, null)).toBe('default value');
    expect(percent(12345)).toBe('12.3%');
    expect(relativeTime(new Date(Date.now() - 3 * 3600000).toISOString())).toBe('3 hours ago');
  });
});
