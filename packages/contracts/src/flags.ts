import { z } from 'zod';

export const FLAG_KEY_PATTERN = /^[a-z0-9][a-z0-9-_.]{0,63}$/;
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-_.]{0,63}$/;
export const CONTEXT_KIND_PATTERN = /^[A-Za-z0-9._-]+$/;

export const flagKeySchema = z.string().regex(FLAG_KEY_PATTERN, 'must match ^[a-z0-9][a-z0-9-_.]{0,63}$');
export const resourceKeySchema = z.string().regex(KEY_PATTERN, 'must match ^[a-z0-9][a-z0-9-_.]{0,63}$');
export const contextKindSchema = z.string().regex(CONTEXT_KIND_PATTERN).max(64);
export const flagKindSchema = z.enum(['boolean', 'string', 'number', 'json']);

export const clauseOpSchema = z.enum([
  'in',
  'not_in',
  'eq',
  'neq',
  'contains',
  'starts_with',
  'ends_with',
  'matches',
  'lt',
  'lte',
  'gt',
  'gte',
  'semver_eq',
  'semver_lt',
  'semver_gt',
  'before',
  'after',
  'segment_match',
]);

export const variationSchema = z.object({
  id: z.string().min(1).max(64),
  value: z.unknown(),
  name: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
});

export const prerequisiteSchema = z.object({
  flagKey: flagKeySchema,
  variationId: z.string().min(1),
});

export const clauseSchema = z.object({
  attribute: z.string().min(1).max(256),
  contextKind: contextKindSchema.optional(),
  op: clauseOpSchema,
  values: z.array(z.unknown()).max(10000),
  negate: z.boolean().optional(),
});

export const weightedVariationSchema = z.object({
  variation: z.string().min(1),
  weight: z.number().int().min(0).max(100000),
});

export const rolloutSchema = z
  .object({
    bucketBy: z.string().min(1).max(256).optional(),
    contextKind: contextKindSchema.optional(),
    weights: z.array(weightedVariationSchema).min(1),
  })
  .refine((r) => r.weights.reduce((s, w) => s + w.weight, 0) === 100000, {
    message: 'rollout weights must sum to 100000',
  });

export const serveSchema = z.union([
  z.object({ variation: z.string().min(1) }).strict(),
  z.object({ rollout: rolloutSchema }).strict(),
]);

export const ruleSchema = z.object({
  id: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  clauses: z.array(clauseSchema).max(50),
  serve: serveSchema,
});

export const targetSchema = z.object({
  variation: z.string().min(1),
  contextKind: contextKindSchema.default('user'),
  keys: z.array(z.string().min(1)).max(10000),
});

export const experimentRefSchema = z.object({ id: z.string(), key: z.string().optional() });

export const flagSchema = z.object({
  key: flagKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  kind: flagKindSchema,
  variations: z.array(variationSchema).min(2).max(50),
  tags: z.array(z.string().min(1).max(64)).max(50).default([]),
  temporary: z.boolean().default(true),
  maintainerId: z.string().optional(),
  prerequisites: z.array(prerequisiteSchema).max(20).optional(),
  salt: z.string().min(1),
  clientSideAvailable: z.boolean().default(false),
  archivedAt: z.string().nullable().optional(),
});

export const flagConfigSchema = z.object({
  flagKey: flagKeySchema,
  env: resourceKeySchema,
  on: z.boolean(),
  offVariation: z.string().nullable(),
  targets: z.array(targetSchema),
  rules: z.array(ruleSchema).max(200),
  fallthrough: serveSchema,
  version: z.number().int().min(0),
  updatedAt: z.string(),
  experiment: experimentRefSchema.nullable().optional(),
});

export const segmentRuleSchema = z.object({
  id: z.string().optional(),
  clauses: z.array(clauseSchema).max(50),
});

export const MAX_SEGMENT_KEYS = 10000;

export const segmentSchema = z.object({
  key: resourceKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  contextKind: contextKindSchema.default('user'),
  included: z.array(z.string().min(1)).max(MAX_SEGMENT_KEYS),
  excluded: z.array(z.string().min(1)).max(MAX_SEGMENT_KEYS),
  rules: z.array(segmentRuleSchema).max(100),
  version: z.number().int().min(0),
});

const singleContextSchema = z.looseObject({ key: z.string().min(1) });

export const contextSchema = z.union([
  z.looseObject({ kind: z.literal('multi') }).refine(
    (ctx) => {
      const kinds = Object.keys(ctx).filter((k) => k !== 'kind');
      return kinds.length > 0 && kinds.every((k) => singleContextSchema.safeParse(ctx[k]).success);
    },
    { message: 'multi context needs at least one nested context with a key' },
  ),
  z.looseObject({ kind: contextKindSchema.optional(), key: z.string().min(1) }),
]);

export const rulesetFlagSchema = flagSchema.extend({
  config: flagConfigSchema.partial({ flagKey: true, env: true, updatedAt: true }),
});

export const rulesetSchema = z.object({
  env: z.string().optional(),
  version: z.number().int(),
  flags: z.record(z.string(), rulesetFlagSchema),
  segments: z.record(z.string(), segmentSchema),
});

export type ClauseOp = z.infer<typeof clauseOpSchema>;
export type FlagKind = z.infer<typeof flagKindSchema>;
export type Variation = z.infer<typeof variationSchema>;
export type Clause = z.infer<typeof clauseSchema>;
export type Rollout = z.infer<typeof rolloutSchema>;
export type Serve = z.infer<typeof serveSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Flag = z.infer<typeof flagSchema>;
export type FlagConfig = z.infer<typeof flagConfigSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type SegmentRule = z.infer<typeof segmentRuleSchema>;
export type Context = z.infer<typeof contextSchema>;
export type RulesetFlag = z.infer<typeof rulesetFlagSchema>;
export type Ruleset = z.infer<typeof rulesetSchema>;
export type Prerequisite = z.infer<typeof prerequisiteSchema>;
