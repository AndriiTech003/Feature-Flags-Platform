import { Inject, Injectable } from '@nestjs/common';
import type {
  ExperimentResults,
  MetricResult,
  Serve,
  VariationMetricResult,
} from '@ashamrai/flags-contracts';
import { iso } from '../db/db';
import { Database } from '../infra/database';
import { sampleRatioMismatch, sampleSizePerVariation, twoProportionZTest, welchTTest } from './stats';

export interface ExperimentRow {
  id: string;
  project_id: string;
  env_id: string;
  flag_id: string;
  key: string;
  name: string;
  hypothesis: string | null;
  metric_ids: string[];
  control_variation_id: string | null;
  minimum_sample_size: number | null;
  status: 'draft' | 'running' | 'stopped';
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
  flag_key: string;
  env_key: string;
  project_key: string;
  org_id: string;
  variations: Array<{ id: string; value: unknown; name?: string }>;
  fallthrough: Serve;
  rules: Array<{ serve: Serve }>;
}

export const EXPERIMENT_SELECT = `SELECT x.*, f.key AS flag_key, f.variations, e.key AS env_key, p.key AS project_key, p.org_id,
  fc.fallthrough, fc.rules
  FROM experiments x
  JOIN flags f ON f.id = x.flag_id
  JOIN environments e ON e.id = x.env_id
  JOIN projects p ON p.id = x.project_id
  JOIN flag_configs fc ON fc.flag_id = x.flag_id AND fc.env_id = x.env_id`;

interface MetricRow {
  id: string;
  key: string;
  name: string;
  event_key: string;
  kind: 'conversion' | 'numeric';
}

export const ALPHA = 0.05;

export function rolloutWeights(
  row: Pick<ExperimentRow, 'fallthrough' | 'rules'>,
): Array<{ variation: string; weight: number }> | null {
  if ('rollout' in row.fallthrough) return row.fallthrough.rollout.weights;
  for (const rule of row.rules) if ('rollout' in rule.serve) return rule.serve.rollout.weights;
  return null;
}

@Injectable()
export class ResultsService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async compute(experiment: ExperimentRow): Promise<ExperimentResults> {
    const start = experiment.started_at ?? new Date();
    const end = experiment.ended_at ?? new Date(Date.now() + 60000);
    const variationName = (id: string) => {
      const variation = experiment.variations.find((v) => v.id === id);
      return variation?.name ?? (variation ? JSON.stringify(variation.value) : id);
    };
    const weights = rolloutWeights(experiment);
    const variationIds = weights
      ? weights.filter((w) => w.weight > 0).map((w) => w.variation)
      : experiment.variations.map((v) => v.id);
    const controlId = experiment.control_variation_id ?? variationIds[0] ?? experiment.variations[0]!.id;
    const unitArgs = [experiment.env_id, experiment.flag_key, start, end];
    const unitsCte = `units AS (
      SELECT context_key, (array_agg(variation_id ORDER BY ts))[1] AS variation_id, min(ts) AS first_ts
      FROM events WHERE env_id = $1 AND kind = 'exposure' AND flag_key = $2 AND in_experiment AND ts >= $3 AND ts <= $4
      GROUP BY context_key)`;
    const exposureRows =
      experiment.status === 'draft'
        ? []
        : await this.db.query<{ variation_id: string; units: number }>(
            `WITH ${unitsCte} SELECT variation_id, count(*)::bigint AS units FROM units GROUP BY variation_id`,
            unitArgs,
          );
    const exposures: Record<string, number> = {};
    for (const id of variationIds) exposures[id] = 0;
    for (const row of exposureRows) if (row.variation_id) exposures[row.variation_id] = row.units;
    const totalUnits = Object.values(exposures).reduce((s, x) => s + x, 0);
    const expectedShare: Record<string, number> = {};
    for (const id of variationIds) {
      expectedShare[id] = weights
        ? weights.find((w) => w.variation === id)!.weight / 100000
        : 1 / variationIds.length;
    }
    const srm = sampleRatioMismatch(
      variationIds.map((id) => exposures[id] ?? 0),
      variationIds.map((id) => expectedShare[id] ?? 0),
    );

    const metrics = await this.db.query<MetricRow>(
      'SELECT id, key, name, event_key, kind FROM metrics WHERE id = ANY($1::uuid[]) ORDER BY key',
      [experiment.metric_ids],
    );
    const eventKeys = [...new Set(metrics.map((m) => m.event_key))];
    const aggregates =
      experiment.status === 'draft' || eventKeys.length === 0
        ? []
        : await this.db.query<{
            variation_id: string;
            event_key: string;
            converters: number;
            total: number;
            total_sq: number;
          }>(
            `WITH ${unitsCte.replace('units AS (', 'units AS MATERIALIZED (')},
             custom AS MATERIALIZED (
               SELECT context_key, event_key, value, ts FROM events
               WHERE env_id = $1 AND kind = 'custom' AND event_key = ANY($5::text[]) AND ts >= $3 AND ts <= $4),
             per_unit AS (
               SELECT u.variation_id, c.event_key, u.context_key, sum(coalesce(c.value, 0)) AS total
               FROM units u JOIN custom c ON c.context_key = u.context_key AND c.ts >= u.first_ts
               GROUP BY u.variation_id, c.event_key, u.context_key)
             SELECT variation_id, event_key, count(*)::bigint AS converters, sum(total)::float8 AS total, sum(total * total)::float8 AS total_sq
             FROM per_unit GROUP BY variation_id, event_key`,
            [...unitArgs, eventKeys],
          );
    const metricResults: MetricResult[] = [];
    for (const metric of metrics) {
      const rows = variationIds.map((id) => {
        const units = exposures[id] ?? 0;
        const agg = aggregates.find((a) => a.variation_id === id && a.event_key === metric.event_key);
        const total = agg?.total ?? 0;
        const totalSq = agg?.total_sq ?? 0;
        const mean = units > 0 ? total / units : 0;
        const variance = units > 1 ? Math.max(0, (totalSq - (total * total) / units) / (units - 1)) : 0;
        return { variation_id: id, units, conversions: agg?.converters ?? 0, mean, variance, total };
      });
      const byVariation = new Map(rows.map((r) => [r.variation_id, r]));
      const control = byVariation.get(controlId) ?? {
        units: 0,
        conversions: 0,
        mean: 0,
        variance: 0,
        total: 0,
      };
      const variations: VariationMetricResult[] = variationIds.map((id) => {
        const row = byVariation.get(id) ?? { units: 0, conversions: 0, mean: 0, variance: 0, total: 0 };
        const base: VariationMetricResult = {
          variationId: id,
          variationName: variationName(id),
          units: row.units,
          isControl: id === controlId,
        };
        if (metric.kind === 'conversion') {
          base.conversions = row.conversions;
          base.rate = row.units > 0 ? row.conversions / row.units : 0;
          if (id !== controlId) {
            const test = twoProportionZTest(
              control.conversions,
              control.units,
              row.conversions,
              row.units,
              ALPHA,
            );
            Object.assign(base, {
              absoluteDifference: test.difference,
              relativeLift: test.relativeLift,
              ciLow: test.ciLow,
              ciHigh: test.ciHigh,
              pValue: test.pValue,
              testStatistic: test.z,
              significant: test.significant,
              test: 'two-proportion-z',
            });
          }
        } else {
          base.mean = row.mean ?? 0;
          base.stdDev = Math.sqrt(row.variance ?? 0);
          base.sum = row.total ?? 0;
          if (id !== controlId) {
            const test = welchTTest(
              { n: control.units, mean: control.mean ?? 0, variance: control.variance ?? 0 },
              { n: row.units, mean: row.mean ?? 0, variance: row.variance ?? 0 },
              ALPHA,
            );
            Object.assign(base, {
              absoluteDifference: test.difference,
              relativeLift: test.relativeLift,
              ciLow: test.ciLow,
              ciHigh: test.ciHigh,
              pValue: test.pValue,
              testStatistic: test.t,
              significant: test.significant,
              test: 'welch-t',
            });
          }
        }
        return base;
      });
      metricResults.push({
        metricKey: metric.key,
        metricName: metric.name,
        kind: metric.kind,
        eventKey: metric.event_key,
        variations,
      });
    }

    const primary = metricResults.find((m) => m.kind === 'conversion');
    const baseline = primary?.variations.find((v) => v.isControl)?.rate ?? 0;
    const computedRequired =
      baseline > 0 && baseline < 1
        ? sampleSizePerVariation(baseline, 0.05, ALPHA, 0.8, variationIds.length)
        : null;
    const required = experiment.minimum_sample_size ?? computedRequired;
    const smallest = Math.min(...variationIds.map((id) => exposures[id] ?? 0));
    const reached = required !== null && smallest >= required;
    const warnings: string[] = [];
    if (srm.mismatch) {
      warnings.push(
        `Sample ratio mismatch (χ²=${srm.chiSquare.toFixed(2)}, p=${srm.pValue.toExponential(2)}): the experiment may be broken, do not trust these results.`,
      );
    }
    if (experiment.status === 'running' && !reached) {
      warnings.push(
        'Planned sample size not reached yet: looking at results early (peeking) inflates the false positive rate.',
      );
    }
    if (variationIds.length > 2) {
      warnings.push(
        `Comparing ${variationIds.length - 1} treatments against control: consider a stricter threshold (Bonferroni α=${(ALPHA / (variationIds.length - 1)).toFixed(4)}).`,
      );
    }
    return {
      experimentId: experiment.id,
      experimentKey: experiment.key,
      status: experiment.status,
      flagKey: experiment.flag_key,
      envKey: experiment.env_key,
      startedAt: iso(experiment.started_at),
      endedAt: iso(experiment.ended_at),
      controlVariationId: controlId,
      confidenceLevel: 1 - ALPHA,
      exposures,
      totalUnits,
      srm: {
        chiSquare: srm.chiSquare,
        pValue: srm.pValue,
        degreesOfFreedom: srm.degreesOfFreedom,
        expectedShare,
        observed: exposures,
        mismatch: srm.mismatch,
      },
      metrics: metricResults,
      sampleSize: {
        requiredPerVariation: required,
        reached,
        minimumSampleSize: experiment.minimum_sample_size,
      },
      warnings,
      computedAt: new Date().toISOString(),
    };
  }
}
