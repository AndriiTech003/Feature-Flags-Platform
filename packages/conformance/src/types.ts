export type ExpectedKind = 'boolean' | 'string' | 'number' | 'json';

export interface ConformanceReason {
  kind: string;
  [field: string]: unknown;
}

export interface ConformanceResult {
  value: unknown;
  variationId: string | null;
  reason: ConformanceReason;
}

export interface VectorCase {
  name: string;
  flagKey: string;
  context: Record<string, unknown>;
  default?: unknown;
  expectedKind?: ExpectedKind;
  expect: ConformanceResult;
}

export interface VectorFlag {
  key: string;
  kind: ExpectedKind;
  salt: string;
  variations: Array<{ id: string; value: unknown; name?: string }>;
  prerequisites?: Array<{ flagKey: string; variationId: string }>;
  clientSideAvailable?: boolean;
  config: {
    on: boolean;
    offVariation: string | null;
    version: number;
    [field: string]: unknown;
  };
  [field: string]: unknown;
}

export interface VectorSegment {
  key: string;
  version: number;
  included: string[];
  excluded: string[];
  rules: Array<{ clauses: unknown[] }>;
  [field: string]: unknown;
}

export interface VectorFile {
  name: string;
  description: string;
  flags: VectorFlag[];
  segments: VectorSegment[];
  cases: VectorCase[];
}

export interface HashCase {
  input: string;
  hash: number;
  bucket: number;
}

export interface ConformanceAdapter {
  name: string;
  load?(file: VectorFile): Promise<void> | void;
  unload?(file: VectorFile): Promise<void> | void;
  evaluate(testCase: VectorCase, file: VectorFile): Promise<ConformanceResult> | ConformanceResult;
}

export interface ConformanceFailure {
  file: string;
  case: string;
  expected: ConformanceResult;
  actual: ConformanceResult | { error: string };
}

export interface ConformanceReport {
  adapter: string;
  total: number;
  passed: number;
  failures: ConformanceFailure[];
}

export interface TestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void, timeout?: number): void;
  beforeAll(fn: () => Promise<void> | void, timeout?: number): void;
  afterAll(fn: () => Promise<void> | void, timeout?: number): void;
  expect(value: unknown): { toEqual(expected: unknown): void };
}
