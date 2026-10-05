import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  registerConformanceSuite,
  rulesetFromVector,
  type ConformanceAdapter,
  type ConformanceResult,
  type VectorCase,
} from '@ffp/conformance';
import type { Ruleset } from '@ashamrai/flags-evaluator';
import type { RunningRelay } from '../../src/app';
import type { MemorySource } from '../../src/source';
import { memoryRelay } from './helpers';

function matchesKind(value: unknown, kind: string): boolean {
  if (kind === 'boolean') return typeof value === 'boolean';
  if (kind === 'string') return typeof value === 'string';
  if (kind === 'number') return typeof value === 'number';
  return value !== undefined;
}

export function finalizeClientResult(
  state: { value: unknown; variationId: string | null; reason: ConformanceResult['reason'] } | undefined,
  testCase: VectorCase,
): ConformanceResult {
  const fallback = testCase.default ?? null;
  if (!state)
    return { value: fallback, variationId: null, reason: { kind: 'ERROR', errorKind: 'FLAG_NOT_FOUND' } };
  if (state.variationId === null) return { value: fallback, variationId: null, reason: state.reason };
  if (testCase.expectedKind && !matchesKind(state.value, testCase.expectedKind)) {
    return { value: fallback, variationId: null, reason: { kind: 'ERROR', errorKind: 'WRONG_TYPE' } };
  }
  return { value: state.value, variationId: state.variationId, reason: state.reason };
}

let relay: RunningRelay;
let source: MemorySource;

const adapter: ConformanceAdapter = {
  name: 'relay server-side evaluation',
  load(file) {
    source.keys.set('cli-conformance', { envId: file.name, kind: 'client' });
    source.snapshots.set(file.name, {
      envId: file.name,
      envKey: file.name,
      version: 1,
      ruleset: rulesetFromVector(file, { clientSideAvailable: true }) as unknown as Ruleset,
    });
  },
  async evaluate(testCase) {
    const response = await fetch(`${relay.url}/sdk/v1/evaluate`, {
      method: 'POST',
      headers: { authorization: 'cli-conformance', 'content-type': 'application/json' },
      body: JSON.stringify({ context: testCase.context, withReasons: true }),
    });
    const body = (await response.json()) as {
      flags: Record<
        string,
        { value: unknown; variationId: string | null; reason: ConformanceResult['reason'] }
      >;
    };
    return finalizeClientResult(body.flags[testCase.flagKey], testCase);
  },
};

beforeAll(async () => {
  ({ relay, source } = await memoryRelay());
});

afterAll(async () => {
  await relay.close();
});

registerConformanceSuite(adapter, { describe, it, beforeAll, afterAll, expect });
