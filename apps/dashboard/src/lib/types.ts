import type {
  ChangeNotification,
  ExperimentResults,
  FlagInsights,
  Instruction,
  Rule,
  Serve,
  Target,
  Variation,
} from '@ashamrai/flags-contracts';

export type {
  ChangeNotification,
  ExperimentResults,
  FlagInsights,
  Instruction,
  Rule,
  Serve,
  Target,
  Variation,
};

export interface Environment {
  id: string;
  key: string;
  name: string;
  color: string;
  requireApproval: boolean;
  version: number;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  role: 'admin' | 'writer' | 'reader';
  organization: { id: string; name: string };
  environments: Environment[];
}

export interface Me {
  id: string;
  email: string;
  name: string;
  organizations: Array<{ id: string; name: string; role: string }>;
}

export interface FlagConfig {
  flagKey: string;
  env: string;
  on: boolean;
  offVariation: string | null;
  targets: Target[];
  rules: Rule[];
  fallthrough: Serve;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
  experiment?: { id: string; key: string } | null;
}

export interface Flag {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: 'boolean' | 'string' | 'number' | 'json';
  variations: Variation[];
  tags: string[];
  temporary: boolean;
  salt: string;
  prerequisites: Array<{ flagKey: string; variationId: string }>;
  clientSideAvailable: boolean;
  maintainerId: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface FlagListItem extends Flag {
  stale: boolean;
  environments: Record<
    string,
    {
      on: boolean;
      version: number;
      lastEvaluatedAt: string | null;
      stale: boolean;
      fallthrough: Serve;
      rulesCount: number;
    }
  >;
}

export interface FlagDetail extends Flag {
  environments: Record<string, FlagConfig>;
}

export interface Segment {
  key: string;
  name: string;
  description: string | null;
  env: string;
  contextKind: string;
  included: string[];
  excluded: string[];
  rules: Array<{ id?: string; clauses: Rule['clauses'] }>;
  version: number;
  updatedAt: string;
  usedBy?: string[];
}

export interface ChangeRequest {
  id: string;
  flagKey: string;
  envKey: string;
  instructions: Instruction[];
  descriptions: string[];
  comment: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
  author: { id: string; name: string } | null;
  reviewer: { id: string; name: string } | null;
  reviewComment: string | null;
  baseVersion: number;
  error: string | null;
  createdAt: string;
  reviewedAt: string | null;
  appliedAt: string | null;
  currentVersion?: number;
  preview?: { before: unknown; after: unknown; diff: DiffEntry[] } | null;
  previewError?: string | null;
}

export interface ScheduledChange {
  id: string;
  flagKey: string;
  envKey: string;
  instructions: Instruction[];
  descriptions: string[];
  executeAt: string;
  status: 'pending' | 'executed' | 'failed' | 'cancelled';
  comment: string | null;
  author: { id: string; name: string } | null;
  error: string | null;
  executedAt: string | null;
}

export interface DiffEntry {
  path: string;
  op: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

export interface AuditEntry {
  id: number;
  action: string;
  resource: string;
  envKey: string | null;
  actor: { id: string | null; name: string | null };
  before: unknown;
  after: unknown;
  instructions: Instruction[] | null;
  descriptions: string[];
  comment: string | null;
  createdAt: string;
}

export interface SdkKey {
  id: string;
  kind: 'server' | 'client';
  name: string | null;
  prefix: string;
  maskedKey: string;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
  key?: string;
}

export interface Metric {
  id: string;
  key: string;
  name: string;
  eventKey: string;
  kind: 'conversion' | 'numeric';
  unit: string | null;
  description: string | null;
}

export interface Experiment {
  id: string;
  key: string;
  name: string;
  hypothesis: string | null;
  flagKey: string;
  envKey: string;
  status: 'draft' | 'running' | 'stopped';
  controlVariationId: string | null;
  minimumSampleSize: number | null;
  metrics: Metric[];
  variations: Variation[];
  rollout: Array<{ variation: string; weight: number }> | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface Webhook {
  id: string;
  url: string;
  projectKey: string | null;
  hasSecret: boolean;
  events: string[];
  enabled: boolean;
  createdAt: string;
}

export interface Member {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'writer' | 'reader';
  joinedAt: string;
}

export interface CompareResult {
  environments: Array<{ key: string; name: string; color: string }>;
  flags: Array<{
    key: string;
    name: string;
    kind: string;
    identical: boolean;
    environments: Record<
      string,
      { on: boolean; version: number; config: unknown; differsFromFirst: boolean; diff: DiffEntry[] }
    >;
  }>;
}
