import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerConformanceSuite, runConformance, totalCases } from '@ffp/conformance';
import { evaluatorAdapter } from './adapter';

registerConformanceSuite(evaluatorAdapter('evaluator'), { describe, it, beforeAll, afterAll, expect });

describe('conformance report', () => {
  it('passes every vector', async () => {
    const report = await runConformance(evaluatorAdapter('evaluator-report'));
    expect(report.failures).toEqual([]);
    expect(report.total).toBe(totalCases);
    expect(totalCases).toBeGreaterThanOrEqual(150);
  });
});
