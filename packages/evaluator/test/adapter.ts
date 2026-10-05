import { rulesetFromVector, type ConformanceAdapter } from '@ffp/conformance';
import { createStore, evaluateFlag, type Context, type EvaluationStore, type Ruleset } from '../src';

export function evaluatorAdapter(name: string): ConformanceAdapter {
  let store: EvaluationStore | undefined;
  return {
    name,
    load(file) {
      store = createStore(rulesetFromVector(file) as unknown as Ruleset);
    },
    evaluate(testCase) {
      return evaluateFlag(store!, testCase.flagKey, testCase.context as Context, {
        defaultValue: testCase.default,
        expectedKind: testCase.expectedKind,
      });
    },
  };
}
