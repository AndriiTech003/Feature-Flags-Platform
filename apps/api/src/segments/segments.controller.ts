import { Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createSegmentSchema, jsonDiff, updateSegmentSchema } from '@ashamrai/flags-contracts';
import type { z } from 'zod';
import { AccessService, bumpEnvVersion, type EnvRow, type ProjectCtx } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { conflict, notFound } from '../common/errors';
import { actorOf, parseIfMatch } from '../common/http';
import { ZBody } from '../common/zod';
import { iso } from '../db/db';
import { ChangesService } from '../flags/changes.service';
import { Database } from '../infra/database';
import { WebhookDispatcher } from '../webhooks/dispatcher';

interface SegmentRow {
  id: string;
  env_id: string;
  key: string;
  name: string;
  description: string | null;
  context_kind: string;
  included: string[];
  excluded: string[];
  rules: unknown[];
  version: number;
  updated_at: Date;
}

function toSegment(row: SegmentRow, envKey: string) {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    env: envKey,
    contextKind: row.context_kind,
    included: row.included,
    excluded: row.excluded,
    rules: row.rules,
    version: row.version,
    updatedAt: iso(row.updated_at),
  };
}

@Controller('projects/:p/envs/:env/segments')
export class SegmentsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ChangesService) private readonly changes: ChangesService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  private async scope(user: AuthUser, p: string, envKey: string, min: 'reader' | 'writer' = 'reader') {
    const project = await this.access.project(user, p, min);
    const env = await this.access.env(project, envKey);
    return { project, env };
  }

  private after(project: ProjectCtx, env: EnvRow, key: string, version: number, user: AuthUser) {
    this.webhooks.emit({
      orgId: project.orgId,
      projectId: project.id,
      projectKey: project.key,
      envKey: env.key,
      event: 'segment.updated',
      text: `updated segment ${key}`,
      actor: actorOf(user),
      data: { segmentKey: key, version },
    });
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Param('p') p: string, @Param('env') envKey: string) {
    const { env } = await this.scope(user, p, envKey);
    const rows = await this.db.query<SegmentRow>('SELECT * FROM segments WHERE env_id = $1 ORDER BY key', [
      env.id,
    ]);
    const usage = await this.db.query<{
      key: string;
      rules: Array<{ clauses: Array<{ op: string; values: unknown[] }> }>;
    }>('SELECT f.key, fc.rules FROM flag_configs fc JOIN flags f ON f.id = fc.flag_id WHERE fc.env_id = $1', [
      env.id,
    ]);
    return {
      items: rows.map((row) => ({
        ...toSegment(row, env.key),
        usedBy: usage
          .filter((u) =>
            u.rules.some((r) =>
              r.clauses.some((c) => c.op === 'segment_match' && c.values.includes(row.key)),
            ),
          )
          .map((u) => u.key),
      })),
    };
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('env') envKey: string,
    @ZBody(createSegmentSchema) body: z.infer<typeof createSegmentSchema>,
  ) {
    const { project, env } = await this.scope(user, p, envKey, 'writer');
    const row = await this.db.tx(async (sql) => {
      const row = await sql.one<SegmentRow>(
        `INSERT INTO segments (env_id, key, name, description, context_kind, included, excluded, rules) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          env.id,
          body.key,
          body.name,
          body.description ?? null,
          body.contextKind,
          body.included,
          body.excluded,
          JSON.stringify(body.rules),
        ],
      );
      const envVersion = await bumpEnvVersion(sql, env.id);
      await this.changes.notifySegment(sql, project, env, row.key, row.version, envVersion, actorOf(user));
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        envId: env.id,
        actor: actorOf(user),
        action: 'segment.created',
        resource: `segment/${row.key}`,
        after: toSegment(row, env.key),
      });
      return row;
    });
    this.after(project, env, row.key, row.version, user);
    return toSegment(row, env.key);
  }

  @Get(':key')
  async get(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('env') envKey: string,
    @Param('key') key: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { env } = await this.scope(user, p, envKey);
    const row = await this.db.maybe<SegmentRow>('SELECT * FROM segments WHERE env_id = $1 AND key = $2', [
      env.id,
      key,
    ]);
    if (!row) throw notFound(`segment ${key}`);
    res.setHeader('ETag', `"${row.version}"`);
    return toSegment(row, env.key);
  }

  @Patch(':key')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('env') envKey: string,
    @Param('key') key: string,
    @ZBody(updateSegmentSchema) body: z.infer<typeof updateSegmentSchema>,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    const { project, env } = await this.scope(user, p, envKey, 'writer');
    const expected = parseIfMatch(ifMatch);
    const row = await this.db.tx(async (sql) => {
      const before = await sql.maybe<SegmentRow>(
        'SELECT * FROM segments WHERE env_id = $1 AND key = $2 FOR UPDATE',
        [env.id, key],
      );
      if (!before) throw notFound(`segment ${key}`);
      if (expected !== null && expected !== before.version)
        throw conflict('segment was modified by someone else', { currentVersion: before.version });
      const row = await sql.one<SegmentRow>(
        `UPDATE segments SET name = $2, description = $3, context_kind = $4, included = $5, excluded = $6, rules = $7, version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          before.id,
          body.name ?? before.name,
          body.description ?? before.description,
          body.contextKind ?? before.context_kind,
          body.included ?? before.included,
          body.excluded ?? before.excluded,
          JSON.stringify(body.rules ?? before.rules),
        ],
      );
      const envVersion = await bumpEnvVersion(sql, env.id);
      await this.changes.notifySegment(sql, project, env, key, row.version, envVersion, actorOf(user));
      const b = toSegment(before, env.key);
      const a = toSegment(row, env.key);
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        envId: env.id,
        actor: actorOf(user),
        action: 'segment.updated',
        resource: `segment/${key}`,
        before: b,
        after: a,
        descriptions: jsonDiff(b, a)
          .filter((d) => !['/version', '/updatedAt'].includes(d.path))
          .map((d) => `${d.op} ${d.path}`),
      });
      return row;
    });
    this.after(project, env, key, row.version, user);
    return toSegment(row, env.key);
  }

  @Delete(':key')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('env') envKey: string,
    @Param('key') key: string,
  ) {
    const { project, env } = await this.scope(user, p, envKey, 'writer');
    const usage = await this.db.query<{ key: string }>(
      `SELECT f.key FROM flag_configs fc JOIN flags f ON f.id = fc.flag_id
       WHERE fc.env_id = $1 AND fc.rules::text LIKE '%segment_match%' AND fc.rules::text LIKE $2`,
      [env.id, `%"${key}"%`],
    );
    if (usage.length > 0) throw conflict(`segment is used by ${usage.map((u) => u.key).join(', ')}`);
    await this.db.tx(async (sql) => {
      const deleted = await sql.query<SegmentRow>(
        'DELETE FROM segments WHERE env_id = $1 AND key = $2 RETURNING *',
        [env.id, key],
      );
      if (deleted.length === 0) throw notFound(`segment ${key}`);
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        envId: env.id,
        actor: actorOf(user),
        action: 'segment.deleted',
        resource: `segment/${key}`,
        before: toSegment(deleted[0]!, env.key),
      });
      const envVersion = await bumpEnvVersion(sql, env.id);
      await this.changes.notifySegment(sql, project, env, key, 0, envVersion, actorOf(user));
    });
    this.after(project, env, key, 0, user);
  }
}
