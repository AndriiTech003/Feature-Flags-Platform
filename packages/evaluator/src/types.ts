export type FlagKind = 'boolean' | 'string' | 'number' | 'json';

export interface Variation {
  id: string;
  value: unknown;
  name?: string;
  description?: string;
}

export interface Prerequisite {
  flagKey: string;
  variationId: string;
}

export interface Flag {
  key: string;
  name?: string;
  description?: string;
  kind: FlagKind;
  variations: Variation[];
  tags?: string[];
  temporary?: boolean;
  maintainerId?: string;
  prerequisites?: Prerequisite[];
  salt: string;
  clientSideAvailable?: boolean;
  archivedAt?: string | null;
}

export type ClauseOp =
  | 'in'
  | 'not_in'
  | 'eq'
  | 'neq'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'matches'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'semver_eq'
  | 'semver_lt'
  | 'semver_gt'
  | 'before'
  | 'after'
  | 'segment_match';

export interface Clause {
  attribute: string;
  contextKind?: string;
  op: ClauseOp;
  values: unknown[];
  negate?: boolean;
}

export interface WeightedVariation {
  variation: string;
  weight: number;
}

export interface Rollout {
  bucketBy?: string;
  contextKind?: string;
  weights: WeightedVariation[];
}

export type Serve = { variation: string } | { rollout: Rollout };

export interface Rule {
  id: string;
  description?: string;
  clauses: Clause[];
  serve: Serve;
}

export interface Target {
  variation: string;
  contextKind?: string;
  keys: string[];
}

export interface ExperimentRef {
  id: string;
  key?: string;
}

export interface FlagConfig {
  flagKey?: string;
  env?: string;
  on: boolean;
  offVariation: string | null;
  targets: Target[];
  rules: Rule[];
  fallthrough: Serve;
  version: number;
  updatedAt?: string;
  experiment?: ExperimentRef | null;
}

export interface FlagWithConfig extends Flag {
  config: FlagConfig;
}

export interface SegmentRule {
  id?: string;
  clauses: Clause[];
}

export interface Segment {
  key: string;
  name?: string;
  contextKind?: string;
  included: string[];
  excluded: string[];
  rules: SegmentRule[];
  version: number;
}

export interface Ruleset {
  env?: string;
  version: number;
  flags: Record<string, FlagWithConfig>;
  segments: Record<string, Segment>;
}

export interface SingleContext {
  kind?: string;
  key: string;
  [attribute: string]: unknown;
}

export interface MultiContext {
  kind: 'multi';
  [kind: string]: unknown;
}

export type Context = SingleContext | MultiContext;

export type ErrorKind = 'FLAG_NOT_FOUND' | 'MALFORMED_FLAG' | 'WRONG_TYPE' | 'INVALID_CONTEXT' | 'EXCEPTION';

export type EvaluationReason =
  | { kind: 'OFF' }
  | { kind: 'TARGET_MATCH' }
  | { kind: 'RULE_MATCH'; ruleIndex: number; ruleId: string; inExperiment?: true }
  | { kind: 'FALLTHROUGH'; inExperiment?: true }
  | { kind: 'PREREQUISITE_FAILED'; prerequisiteKey: string }
  | { kind: 'ERROR'; errorKind: ErrorKind };

export type ReasonKind = EvaluationReason['kind'];

export interface EvaluationDetail<T = unknown> {
  value: T;
  variationId: string | null;
  reason: EvaluationReason;
}

export interface EvaluationStore {
  getFlag(key: string): FlagWithConfig | undefined;
  getSegment(key: string): Segment | undefined;
}

export interface EvaluateOptions<T = unknown> {
  defaultValue?: T;
  expectedKind?: FlagKind;
}
