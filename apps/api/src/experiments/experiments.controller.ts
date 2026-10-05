import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  createExperimentSchema,
  createMetricSchema,
  sampleSizeQuerySchema,
  updateExperimentSchema,
  updateMetricSchema,
  type SampleSizeResult,
} from '@ashamrai/flags-contracts';
import type { z } from 'zod';
import { AccessService, bumpEnvVersion, type ProjectCtx } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { badRequest, conflict, notFound } from '../common/errors';
import { actorOf } from '../common/http';
import { ZBody, ZQuery } from '../common/zod';
import { iso } from '../db/db';
import { ChangesService } from '../flags/changes.service';
import { FlagsService } from '../flags/flags.service';
import { Database } from '../infra/database';
import { WebhookDispatcher } from '../webhooks/dispatcher';
import { EXPERIMENT_SELECT, ResultsService, rolloutWeights, type ExperimentRow } from './results.service';
import { sampleSizePerVariation } from './stats';

interface MetricRow {
  id: string;
  key: string;
  name: string;
  event_key: string;
  kind: string;
  unit: string | null;
  description: string | null;
  created_at: Date;
}

const toMetric = (r: MetricRow) => ({
  id: r.id,
  key: r.key,
  name: r.name,
  eventKey: r.event_key,
  kind: r.kind,
  unit: r.unit,
  description: r.description,
  createdAt: iso(r.created_at),
});

@Controller()
export class ExperimentsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FlagsService) private readonly flags: FlagsService,
    @Inject(ChangesService) private readonly changes: ChangesService,
    @Inject(ResultsService) private readonly results: ResultsService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  @Get('projects/:p/metrics')
  async metrics(@CurrentUser() user: AuthUser, @Param('p') p: string) {
    const project = await this.access.project(user, p);
    return {
      items: (
        await this.db.query<MetricRow>('SELECT * FROM metrics WHERE project_id = $1 ORDER BY key', [
          project.id,
        ])
      ).map(toMetric),
    };
  }

  @Post('projects/:p/metrics')
  async createMetric(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @ZBody(createMetricSchema) body: z.infer<typeof createMetricSchema>,
  ) {
    const project = await this.access.project(user, p, 'writer');
    const row = await this.db.one<MetricRow>(
      'INSERT INTO metrics (project_id, key, name, event_key, kind, unit, description) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [
        project.id,
        body.key,
        body.name,
        body.eventKey,
        body.kind,
        body.unit ?? null,
        body.description ?? null,
      ],
    );
    await this.audit.record(this.db, {
      orgId: project.orgId,
      projectId: project.id,
      actor: actorOf(user),
      action: 'metric.created',
      resource: `metric/${row.key}`,
      after: toMetric(row),
    });
    return toMetric(row);
  }

  @Get('projects/:p/metrics/:key')
  async metric(@CurrentUser() user: AuthUser, @Param('p') p: string, @Param('key') key: string) {
    const project = await this.access.project(user, p);
    const row = await this.db.maybe<MetricRow>('SELECT * FROM metrics WHERE project_id = $1 AND key = $2', [
      project.id,
      key,
    ]);
    if (!row) throw notFound(`metric ${key}`);
    return toMetric(row);
  }

  @Patch('projects/:p/metrics/:key')
  async updateMetric(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('key') key: string,
    @ZBody(updateMetricSchema) body: z.infer<typeof updateMetricSchema>,
  ) {
    const project = await this.access.project(user, p, 'writer');
    const row = await this.db.maybe<MetricRow>(
      `UPDATE metrics SET name = coalesce($3, name), event_key = coalesce($4, event_key), kind = coalesce($5, kind), unit = coalesce($6, unit), description = coalesce($7, description)
       WHERE project_id = $1 AND key = $2 RETURNING *`,
      [
        project.id,
        key,
        body.name ?? null,
        body.eventKey ?? null,
        body.kind ?? null,
        body.unit ?? null,
        body.description ?? null,
      ],
    );
    if (!row) throw notFound(`metric ${key}`);
    await this.audit.record(this.db, {
      orgId: project.orgId,
      projectId: project.id,
      actor: actorOf(user),
      action: 'metric.updated',
      resource: `metric/${key}`,
      after: toMetric(row),
    });
    return toMetric(row);
  }

  @Delete('projects/:p/metrics/:key')
  @HttpCode(204)
  async deleteMetric(@CurrentUser() user: AuthUser, @Param('p') p: string, @Param('key') key: string) {
    const project = await this.access.project(user, p, 'writer');
    const used = await this.db.query(
      'SELECT 1 FROM experiments x JOIN metrics m ON m.id = ANY(x.metric_ids) WHERE m.project_id = $1 AND m.key = $2',
      [project.id, key],
    );
    if (used.length > 0) throw conflict('metric is used by an experiment');
    await this.db.query('DELETE FROM metrics WHERE project_id = $1 AND key = $2', [project.id, key]);
    await this.audit.record(this.db, {
      orgId: project.orgId,
      projectId: project.id,
      actor: actorOf(user),
      action: 'metric.deleted',
      resource: `metric/${key}`,
    });
  }

  private async experimentRow(id: string): Promise<ExperimentRow> {
    const row = await this.db.maybe<ExperimentRow>(`${EXPERIMENT_SELECT} WHERE x.id = $1`, [id]);
    if (!row) throw notFound('experiment');
    return row;
  }

  private async toExperiment(row: ExperimentRow) {
    const metrics = await this.db.query<MetricRow>(
      'SELECT * FROM metrics WHERE id = ANY($1::uuid[]) ORDER BY key',
      [row.metric_ids],
    );
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      hypothesis: row.hypothesis,
      flagKey: row.flag_key,
      envKey: row.env_key,
      status: row.status,
      controlVariationId: row.control_variation_id,
      minimumSampleSize: row.minimum_sample_size,
      metrics: metrics.map(toMetric),
      variations: row.variations,
      rollout: rolloutWeights(row),
      startedAt: iso(row.started_at),
      endedAt: iso(row.ended_at),
      createdAt: iso(row.created_at),
    };
  }

  private async metricIds(project: ProjectCtx, keys: string[]): Promise<string[]> {
    const rows = await this.db.query<{ id: string; key: string }>(
      'SELECT id, key FROM metrics WHERE project_id = $1 AND key = ANY($2::text[])',
      [project.id, keys],
    );
    const missing = keys.filter((k) => !rows.some((r) => r.key === k));
    if (missing.length > 0) throw badRequest(`unknown metrics: ${missing.join(', ')}`);
    return keys.map((k) => rows.find((r) => r.key === k)!.id);
  }

  @Get('projects/:p/experiments')
  async list(@CurrentUser() user: AuthUser, @Param('p') p: string) {
    const project = await this.access.project(user, p);
    const rows = await this.db.query<ExperimentRow>(
      `${EXPERIMENT_SELECT} WHERE x.project_id = $1 ORDER BY x.created_at DESC`,
      [project.id],
    );
    return { items: await Promise.all(rows.map((r) => this.toExperiment(r))) };
  }

  @Post('projects/:p/experiments')
  async create(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @ZBody(createExperimentSchema) body: z.infer<typeof createExperimentSchema>,
  ) {
    const project = await this.access.project(user, p, 'writer');
    const flag = await this.flags.flagRow(project.id, body.flagKey);
    const env = await this.access.env(project, body.envKey);
    if (body.controlVariationId && !flag.variations.some((v) => v.id === body.controlVariationId))
      throw badRequest('unknown control variation');
    const ids = await this.metricIds(project, body.metricKeys);
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO experiments (project_id, env_id, flag_id, key, name, hypothesis, metric_ids, control_variation_id, minimum_sample_size, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft') RETURNING id`,
      [
        project.id,
        env.id,
        flag.id,
        body.key,
        body.name,
        body.hypothesis ?? null,
        ids,
        body.controlVariationId ?? null,
        body.minimumSampleSize ?? null,
      ],
    );
    await this.audit.record(this.db, {
      orgId: project.orgId,
      projectId: project.id,
      envId: env.id,
      actor: actorOf(user),
      action: 'experiment.created',
      resource: `experiment/${body.key}`,
      after: body,
    });
    return this.toExperiment(await this.experimentRow(row.id));
  }

  @Get('projects/:p/experiments/:key')
  async get(@CurrentUser() user: AuthUser, @Param('p') p: string, @Param('key') key: string) {
    const project = await this.access.project(user, p);
    const row = await this.db.maybe<ExperimentRow>(
      `${EXPERIMENT_SELECT} WHERE x.project_id = $1 AND x.key = $2`,
      [project.id, key],
    );
    if (!row) throw notFound(`experiment ${key}`);
    return this.toExperiment(row);
  }

  @Patch('projects/:p/experiments/:key')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('key') key: string,
    @ZBody(updateExperimentSchema) body: z.infer<typeof updateExperimentSchema>,
  ) {
    const project = await this.access.project(user, p, 'writer');
    const row = await this.db.maybe<ExperimentRow>(
      `${EXPERIMENT_SELECT} WHERE x.project_id = $1 AND x.key = $2`,
      [project.id, key],
    );
    if (!row) throw notFound(`experiment ${key}`);
    const ids = body.metricKeys ? await this.metricIds(project, body.metricKeys) : row.metric_ids;
    await this.db.query(
      `UPDATE experiments SET name = $2, hypothesis = $3, metric_ids = $4, control_variation_id = $5, minimum_sample_size = $6 WHERE id = $1`,
      [
        row.id,
        body.name ?? row.name,
        body.hypothesis ?? row.hypothesis,
        ids,
        body.controlVariationId ?? row.control_variation_id,
        body.minimumSampleSize ?? row.minimum_sample_size,
      ],
    );
    await this.audit.record(this.db, {
      orgId: project.orgId,
      projectId: project.id,
      envId: row.env_id,
      actor: actorOf(user),
      action: 'experiment.updated',
      resource: `experiment/${key}`,
      after: body,
    });
    return this.toExperiment(await this.experimentRow(row.id));
  }

  @Delete('projects/:p/experiments/:key')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('p') p: string, @Param('key') key: string) {
    const project = await this.access.project(user, p, 'writer');
    const row = await this.db.maybe<ExperimentRow>(
      `${EXPERIMENT_SELECT} WHERE x.project_id = $1 AND x.key = $2`,
      [project.id, key],
    );
    if (!row) throw notFound(`experiment ${key}`);
    if (row.status === 'running') throw conflict('stop the experiment before deleting it');
    await this.db.query('DELETE FROM experiments WHERE id = $1', [row.id]);
    await this.audit.record(this.db, {
      orgId: project.orgId,
      projectId: project.id,
      envId: row.env_id,
      actor: actorOf(user),
      action: 'experiment.deleted',
      resource: `experiment/${key}`,
    });
  }

  private async transition(user: AuthUser, id: string, to: 'running' | 'stopped') {
    const row = await this.experimentRow(id);
    const project = await this.access.project(user, row.project_key, 'writer');
    if (to === 'running' && row.status === 'running') throw conflict('experiment is already running');
    if (to === 'stopped' && row.status !== 'running') throw conflict('experiment is not running');
    await this.db.tx(async (sql) => {
      if (to === 'running') {
        await sql.query(
          "UPDATE experiments SET status = 'running', started_at = now(), ended_at = NULL WHERE id = $1",
          [id],
        );
      } else {
        await sql.query("UPDATE experiments SET status = 'stopped', ended_at = now() WHERE id = $1", [id]);
      }
      const version = await bumpEnvVersion(sql, row.env_id);
      const config = await sql.one<{ version: number }>(
        'SELECT version FROM flag_configs WHERE flag_id = $1 AND env_id = $2',
        [row.flag_id, row.env_id],
      );
      await this.changes.notifyFlag(
        sql,
        project,
        { id: row.env_id, key: row.env_key },
        row.flag_key,
        config.version,
        version,
        actorOf(user),
      );
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        envId: row.env_id,
        actor: actorOf(user),
        action: to === 'running' ? 'experiment.started' : 'experiment.stopped',
        resource: `experiment/${row.key}`,
      });
      return version;
    });
    this.webhooks.emit({
      orgId: project.orgId,
      projectId: project.id,
      projectKey: project.key,
      envKey: row.env_key,
      event: 'experiment.updated',
      text: `${to === 'running' ? 'started' : 'stopped'} experiment ${row.key}`,
      actor: actorOf(user),
      data: { experiment: row.key },
    });
    return this.toExperiment(await this.experimentRow(id));
  }

  @Post('experiments/:id/start')
  start(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transition(user, id, 'running');
  }

  @Post('experiments/:id/stop')
  stop(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transition(user, id, 'stopped');
  }

  @Get('experiments/sample-size')
  sampleSize(@ZQuery(sampleSizeQuerySchema) query: z.infer<typeof sampleSizeQuerySchema>): SampleSizeResult {
    const perVariation = sampleSizePerVariation(
      query.baselineRate,
      query.minimumDetectableEffect,
      query.alpha,
      query.power,
      query.variants,
    );
    return {
      perVariation,
      total: perVariation * query.variants,
      baselineRate: query.baselineRate,
      targetRate: query.baselineRate * (1 + query.minimumDetectableEffect),
      alpha: query.alpha,
      power: query.power,
      variants: query.variants,
    };
  }

  @Get('experiments/:id/results')
  async resultsFor(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const row = await this.experimentRow(id);
    await this.access.project(user, row.project_key);
    return this.results.compute(row);
  }
}
