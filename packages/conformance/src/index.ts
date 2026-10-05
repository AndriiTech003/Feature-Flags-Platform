import basics from '../vectors/basics.json';
import hashing from '../vectors/hashing.json';
import operators from '../vectors/operators.json';
import prerequisites from '../vectors/prerequisites.json';
import rollouts from '../vectors/rollouts.json';
import rules from '../vectors/rules.json';
import segments from '../vectors/segments.json';
import targets from '../vectors/targets.json';
import unicode from '../vectors/unicode.json';
import type {
  ConformanceAdapter,
  ConformanceReport,
  ConformanceResult,
  HashCase,
  TestApi,
  VectorCase,
  VectorFile,
} from './types';

export * from './types';

export const vectorFiles: VectorFile[] = [
  basics,
  targets,
  operators,
  rules,
  segments,
  prerequisites,
  rollouts,
  unicode,
] as unknown as VectorFile[];

export const hashVectors: HashCase[] = (hashing as { cases: HashCase[] }).cases;

export const totalCases: number = vectorFiles.reduce((sum, file) => sum + file.cases.length, 0);

export function normalizeResult(result: ConformanceResult): ConformanceResult {
  const reason: Record<string, unknown> = { ...result.reason };
  if (reason.inExperiment !== true) delete reason.inExperiment;
  return {
    value: result.value === undefined ? null : result.value,
    variationId: result.variationId ?? null,
    reason: reason as ConformanceResult['reason'],
  };
}

export function expectedFor(testCase: VectorCase): ConformanceResult {
  return normalizeResult(testCase.expect);
}

export function sameResult(expected: ConformanceResult, actual: ConformanceResult): boolean {
  return (
    JSON.stringify(sortKeys(normalizeResult(expected))) === JSON.stringify(sortKeys(normalizeResult(actual)))
  );
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function rulesetFromVector(file: VectorFile, overrides: { clientSideAvailable?: boolean } = {}) {
  const flags: Record<string, VectorFile['flags'][number]> = {};
  for (const flag of file.flags) {
    flags[flag.key] =
      overrides.clientSideAvailable === undefined
        ? flag
        : { ...flag, clientSideAvailable: overrides.clientSideAvailable };
  }
  const segments: Record<string, VectorFile['segments'][number]> = {};
  for (const segment of file.segments) segments[segment.key] = segment;
  return { env: `conformance-${file.name}`, version: 1, flags, segments };
}

export async function runConformance(adapter: ConformanceAdapter): Promise<ConformanceReport> {
  const report: ConformanceReport = { adapter: adapter.name, total: 0, passed: 0, failures: [] };
  for (const file of vectorFiles) {
    await adapter.load?.(file);
    for (const testCase of file.cases) {
      report.total++;
      const expected = expectedFor(testCase);
      try {
        const actual = normalizeResult(await adapter.evaluate(testCase, file));
        if (sameResult(expected, actual)) report.passed++;
        else report.failures.push({ file: file.name, case: testCase.name, expected, actual });
      } catch (error) {
        report.failures.push({
          file: file.name,
          case: testCase.name,
          expected,
          actual: { error: String(error) },
        });
      }
    }
    await adapter.unload?.(file);
  }
  return report;
}

export function registerConformanceSuite(adapter: ConformanceAdapter, t: TestApi): void {
  t.describe(`conformance: ${adapter.name}`, () => {
    for (const file of vectorFiles) {
      t.describe(file.name, () => {
        t.beforeAll(() => adapter.load?.(file), 30000);
        t.afterAll(() => adapter.unload?.(file), 30000);
        for (const testCase of file.cases) {
          t.it(testCase.name, async () => {
            const actual = normalizeResult(await adapter.evaluate(testCase, file));
            t.expect(sortKeys(actual)).toEqual(sortKeys(expectedFor(testCase)));
          });
        }
      });
    }
  });
}
