import { z } from 'zod';
import {
  clauseSchema,
  contextKindSchema,
  flagKeySchema,
  flagKindSchema,
  prerequisiteSchema,
  resourceKeySchema,
  segmentRuleSchema,
  variationSchema,
  MAX_SEGMENT_KEYS,
} from './flags';
import { instructionListSchema } from './patch';

export const roleSchema = z.enum(['admin', 'writer', 'reader']);
export type Role = z.infer<typeof roleSchema>;

export const signupSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(200),
  organizationName: z.string().min(1).max(200).optional(),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const createOrganizationSchema = z.object({ name: z.string().min(1).max(200) });

export const inviteMemberSchema = z.object({
  email: z.email(),
  role: roleSchema,
  name: z.string().min(1).max(200).optional(),
});

export const updateMemberSchema = z.object({ role: roleSchema });

export const createProjectSchema = z.object({
  key: resourceKeySchema,
  name: z.string().min(1).max(200),
  organizationId: z.string().uuid().optional(),
  environments: z
    .array(z.object({ key: resourceKeySchema, name: z.string(), color: z.string().optional() }))
    .optional(),
});

export const updateProjectSchema = z.object({ name: z.string().min(1).max(200) });

export const createEnvironmentSchema = z.object({
  key: resourceKeySchema,
  name: z.string().min(1).max(200),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#64748b'),
  requireApproval: z.boolean().default(false),
});

export const updateEnvironmentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  requireApproval: z.boolean().optional(),
});

export const createFlagSchema = z.object({
  key: flagKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  kind: flagKindSchema.default('boolean'),
  variations: z.array(variationSchema).min(2).max(50).optional(),
  tags: z.array(z.string().min(1).max(64)).max(50).default([]),
  temporary: z.boolean().default(true),
  clientSideAvailable: z.boolean().default(false),
  prerequisites: z.array(prerequisiteSchema).max(20).optional(),
  maintainerId: z.string().uuid().optional(),
  defaultOnVariation: z.string().optional(),
  defaultOffVariation: z.string().optional(),
});

export const updateFlagSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  temporary: z.boolean().optional(),
  clientSideAvailable: z.boolean().optional(),
  prerequisites: z.array(prerequisiteSchema).max(20).optional(),
  maintainerId: z.string().uuid().nullable().optional(),
  variations: z.array(variationSchema).min(2).max(50).optional(),
  archived: z.boolean().optional(),
});

export const createSegmentSchema = z.object({
  key: resourceKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  contextKind: contextKindSchema.default('user'),
  included: z.array(z.string().min(1)).max(MAX_SEGMENT_KEYS).default([]),
  excluded: z.array(z.string().min(1)).max(MAX_SEGMENT_KEYS).default([]),
  rules: z.array(segmentRuleSchema).max(100).default([]),
});

export const updateSegmentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  contextKind: contextKindSchema.optional(),
  included: z.array(z.string().min(1)).max(MAX_SEGMENT_KEYS).optional(),
  excluded: z.array(z.string().min(1)).max(MAX_SEGMENT_KEYS).optional(),
  rules: z.array(segmentRuleSchema).max(100).optional(),
});

export const sdkKeyKindSchema = z.enum(['server', 'client']);
export const createSdkKeySchema = z.object({ kind: sdkKeyKindSchema, name: z.string().max(200).optional() });
export const rotateSdkKeySchema = z.object({
  gracePeriodMinutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 30)
    .default(60 * 24),
});

export const createChangeRequestSchema = z.object({
  instructions: instructionListSchema,
  comment: z.string().max(2000).optional(),
});

export const reviewChangeRequestSchema = z.object({ comment: z.string().max(2000).optional() });

export const createScheduledChangeSchema = z.object({
  instructions: instructionListSchema,
  executeAt: z.iso.datetime({ offset: true }),
  comment: z.string().max(2000).optional(),
});

export const copyConfigSchema = z.object({
  source: resourceKeySchema,
  target: resourceKeySchema,
  dryRun: z.boolean().default(true),
  includeTargets: z.boolean().default(true),
  comment: z.string().max(2000).optional(),
});

export const metricKindSchema = z.enum(['conversion', 'numeric']);
export const createMetricSchema = z.object({
  key: resourceKeySchema,
  name: z.string().min(1).max(200),
  eventKey: z.string().min(1).max(128),
  kind: metricKindSchema,
  unit: z.string().max(32).optional(),
  description: z.string().max(2000).optional(),
});
export const updateMetricSchema = createMetricSchema.partial().omit({ key: true });

export const experimentStatusSchema = z.enum(['draft', 'running', 'stopped']);
export const createExperimentSchema = z.object({
  key: resourceKeySchema,
  name: z.string().min(1).max(200),
  hypothesis: z.string().max(2000).optional(),
  envKey: resourceKeySchema,
  flagKey: flagKeySchema,
  metricKeys: z.array(resourceKeySchema).min(1).max(20),
  controlVariationId: z.string().optional(),
  minimumSampleSize: z.number().int().positive().optional(),
});
export const updateExperimentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  hypothesis: z.string().max(2000).optional(),
  metricKeys: z.array(resourceKeySchema).min(1).max(20).optional(),
  controlVariationId: z.string().optional(),
  minimumSampleSize: z.number().int().positive().optional(),
});

export const sampleSizeQuerySchema = z.object({
  baselineRate: z.coerce.number().gt(0).lt(1),
  minimumDetectableEffect: z.coerce.number().gt(0).lt(10),
  alpha: z.coerce.number().gt(0).lt(0.5).default(0.05),
  power: z.coerce.number().gt(0.5).lt(1).default(0.8),
  variants: z.coerce.number().int().min(2).max(20).default(2),
});

export const webhookEventSchema = z.enum([
  'flag.created',
  'flag.updated',
  'flag.archived',
  'flag.config.updated',
  'segment.updated',
  'change_request.created',
  'change_request.applied',
  'experiment.updated',
  '*',
]);
export const createWebhookSchema = z.object({
  url: z.url(),
  secret: z.string().min(8).max(200).optional(),
  events: z.array(webhookEventSchema).min(1).default(['*']),
  projectKey: resourceKeySchema.optional(),
  enabled: z.boolean().default(true),
});
export const updateWebhookSchema = createWebhookSchema.partial();

export const auditQuerySchema = z.object({
  env: z.string().optional(),
  resource: z.string().optional(),
  action: z.string().optional(),
  actor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.string().optional(),
});

export const evaluateRequestSchema = z.object({
  context: z.record(z.string(), z.unknown()),
  withReasons: z.boolean().optional(),
});

export const clauseListSchema = z.array(clauseSchema);

export type SignupInput = z.infer<typeof signupSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateEnvironmentInput = z.infer<typeof createEnvironmentSchema>;
export type CreateFlagInput = z.input<typeof createFlagSchema>;
export type UpdateFlagInput = z.infer<typeof updateFlagSchema>;
export type CreateSegmentInput = z.input<typeof createSegmentSchema>;
export type UpdateSegmentInput = z.infer<typeof updateSegmentSchema>;
export type CreateMetricInput = z.infer<typeof createMetricSchema>;
export type CreateExperimentInput = z.infer<typeof createExperimentSchema>;
export type CreateWebhookInput = z.input<typeof createWebhookSchema>;
export type SampleSizeQuery = z.infer<typeof sampleSizeQuerySchema>;

export interface SrmCheck {
  chiSquare: number;
  pValue: number;
  degreesOfFreedom: number;
  expectedShare: Record<string, number>;
  observed: Record<string, number>;
  mismatch: boolean;
}

export interface VariationMetricResult {
  variationId: string;
  variationName: string;
  units: number;
  conversions?: number;
  rate?: number;
  mean?: number;
  stdDev?: number;
  sum?: number;
  isControl: boolean;
  absoluteDifference?: number;
  relativeLift?: number;
  ciLow?: number;
  ciHigh?: number;
  pValue?: number;
  testStatistic?: number;
  significant?: boolean;
  test?: 'two-proportion-z' | 'welch-t';
}

export interface MetricResult {
  metricKey: string;
  metricName: string;
  kind: 'conversion' | 'numeric';
  eventKey: string;
  variations: VariationMetricResult[];
}

export interface ExperimentResults {
  experimentId: string;
  experimentKey: string;
  status: 'draft' | 'running' | 'stopped';
  flagKey: string;
  envKey: string;
  startedAt: string | null;
  endedAt: string | null;
  controlVariationId: string;
  confidenceLevel: number;
  exposures: Record<string, number>;
  totalUnits: number;
  srm: SrmCheck;
  metrics: MetricResult[];
  sampleSize: { requiredPerVariation: number | null; reached: boolean; minimumSampleSize: number | null };
  warnings: string[];
  computedAt: string;
}

export interface SampleSizeResult {
  perVariation: number;
  total: number;
  baselineRate: number;
  targetRate: number;
  alpha: number;
  power: number;
  variants: number;
}

export interface FlagInsights {
  flagKey: string;
  envKey: string;
  last24h: Array<{ variationId: string | null; count: number }>;
  last7d: Array<{ variationId: string | null; count: number }>;
  series: Array<{ bucket: string; variationId: string | null; count: number }>;
  lastEvaluatedAt: string | null;
  stale: boolean;
}
