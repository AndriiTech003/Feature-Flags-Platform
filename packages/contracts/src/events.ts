import { z } from 'zod';

export const exposureEventSchema = z.object({
  kind: z.literal('exposure'),
  flagKey: z.string().min(1).max(64),
  variationId: z.string().nullable(),
  contextKey: z.string().min(1).max(512),
  contextKind: z.string().max(64).optional(),
  inExperiment: z.boolean().optional(),
  version: z.number().int().optional(),
  reason: z.string().max(64).optional(),
  attributes: z.array(z.string().max(256)).max(200).optional(),
  ts: z.number().int().positive(),
});

export const customEventSchema = z.object({
  kind: z.literal('custom'),
  key: z.string().min(1).max(128),
  contextKey: z.string().min(1).max(512),
  value: z.number().finite().optional(),
  data: z.unknown().optional(),
  ts: z.number().int().positive(),
});

export const summaryEventSchema = z.object({
  kind: z.literal('summary'),
  startTs: z.number().int().positive(),
  endTs: z.number().int().positive(),
  counters: z
    .array(
      z.object({
        flagKey: z.string().min(1).max(64),
        variationId: z.string().nullable(),
        version: z.number().int().optional(),
        count: z.number().int().positive(),
      }),
    )
    .max(10000),
});

export const diagnosticEventSchema = z.looseObject({
  kind: z.literal('diagnostic'),
  id: z.string().max(128),
  sdk: z.object({ name: z.string().max(64), version: z.string().max(32) }),
  ts: z.number().int().positive(),
  initDurationMs: z.number().nullable().optional(),
  reconnects: z.number().int().optional(),
  eventsInQueue: z.number().int().optional(),
  droppedEvents: z.number().int().optional(),
  dedupedExposures: z.number().int().optional(),
  dataSource: z.string().max(32).optional(),
});

export const sdkEventSchema = z.discriminatedUnion('kind', [
  exposureEventSchema,
  customEventSchema,
  summaryEventSchema,
  diagnosticEventSchema,
]);

export const eventBatchSchema = z.object({ events: z.array(sdkEventSchema).max(20000) });

export type ExposureEvent = z.infer<typeof exposureEventSchema>;
export type CustomEvent = z.infer<typeof customEventSchema>;
export type SummaryEvent = z.infer<typeof summaryEventSchema>;
export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;
export type SdkEvent = z.infer<typeof sdkEventSchema>;
export type EventBatch = z.infer<typeof eventBatchSchema>;

export interface ChangeNotification {
  type: 'flag.changed' | 'segment.changed' | 'env.changed';
  envId: string;
  envKey: string;
  projectId: string;
  projectKey: string;
  flagKey?: string;
  segmentKey?: string;
  version: number;
  envVersion: number;
  actor?: { id: string; name: string } | null;
  at: string;
}

export const changesChannel = (prefix: string): string => `${prefix}:changes`;
export const sdkKeysChannel = (prefix: string): string => `${prefix}:sdk-keys`;
