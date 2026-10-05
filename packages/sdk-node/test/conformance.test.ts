import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerConformanceSuite, rulesetFromVector, type ConformanceAdapter } from '@ffp/conformance';
import { init, type Context, type FlagsClient, type Ruleset } from '../src';

function sdkAdapter(): ConformanceAdapter {
  let client: FlagsClient | null = null;
  return {
    name: 'sdk-node',
    load(file) {
      client = init({
        sdkKey: 'srv-offline',
        offline: true,
        bootstrap: rulesetFromVector(file) as unknown as Ruleset,
        logger: undefined,
      });
    },
    async unload() {
      await client?.close();
    },
    evaluate(testCase) {
      const ctx = testCase.context as Context;
      const c = client!;
      switch (testCase.expectedKind) {
        case 'boolean':
          return c.boolVariationDetail(testCase.flagKey, ctx, testCase.default as boolean);
        case 'string':
          return c.stringVariationDetail(testCase.flagKey, ctx, testCase.default as string);
        case 'number':
          return c.numberVariationDetail(testCase.flagKey, ctx, testCase.default as number);
        case 'json':
          return c.jsonVariationDetail(testCase.flagKey, ctx, testCase.default);
        default:
          return c.variationDetail(testCase.flagKey, ctx, testCase.default);
      }
    },
  };
}

registerConformanceSuite(sdkAdapter(), { describe, it, beforeAll, afterAll, expect });
