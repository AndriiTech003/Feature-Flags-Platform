import { Inject, Injectable } from '@nestjs/common';
import {
  instructionsBetween,
  jsonDiff,
  type CreateFlagInput,
  type Prerequisite,
  type UpdateFlagInput,
  type Variation,
  createFlagSchema,
} from '@ashamrai/flags-contracts';
import type { z } from 'zod';
import { AccessService, bumpEnvVersion, type EnvRow, type ProjectCtx } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { randomSalt } from '../common/crypto';
import { badRequest, conflict, notFound, unprocessable } from '../common/errors';
import type { Sql } from '../db/db';
import { iso } from '../db/db';
import { Database } from '../infra/database';
import { WebhookDispatcher } from '../webhooks/dispatcher';
import { ChangesService, type Actor } from './changes.service';
import {
  patchable,
  toConfig,
  toFlag,
  type ConfigRow,
  type FlagConfigDto,
  type FlagDto,
  type FlagRow,
} from './model';

export const STALE_DAYS = 30;

export interface FlagListItem extends FlagDto {
  environments: Record<
    string,
    {
      on: boolean;
      version: number;
      lastEvaluatedAt: string | null;
      stale: boolean;
      fallthrough: unknown;
      rulesCount: number;
    }
  >;
  stale: boolean;
}

export interface FlagListFilters {
  q?: string;
  tag?: string;
  temporary?: string;
  stale?: string;
  archived?: string;
}

function isStale(createdAt: Date | string, lastEvaluatedAt: Date | string | null, now = Date.now()): boolean {
  const threshold = now - STALE_DAYS * 86400000;
  if (lastEvaluatedAt) return new Date(lastEvaluatedAt).getTime() < threshold;
  return new Date(createdAt).getTime() < threshold;
}

@Injectable()
export class FlagsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ChangesService) private readonly changes: ChangesService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  async flagRow(projectId: string, key: string, sql: Sql = this.db): Promise<FlagRow> {
    const row = await sql.maybe<FlagRow>('SELECT * FROM flags WHERE project_id = $1 AND key = $2', [
      projectId,
      key,
    ]);
    if (!row) throw notFound(`flag ${key}`);
    return row;
  }

  async list(project: ProjectCtx, filters: FlagListFilters): Promise<FlagListItem[]> {
    const envs = await this.access.envs(project.id);
    const where = ['f.project_id = $1'];
    const params: unknown[] = [project.id];
    if (filters.archived === 'true') where.push('f.archived_at IS NOT NULL');
    else if (filters.archived !== 'all') where.push('f.archived_at IS NULL');
    if (filters.q) {
      params.push(`%${filters.q}%`);
      where.push(
        `(f.key ILIKE $${params.length} OR f.name ILIKE $${params.length} OR coalesce(f.description, '') ILIKE $${params.length})`,
      );
    }
    if (filters.tag) {
      params.push(filters.tag.split(','));
      where.push(`f.tags && $${params.length}::text[]`);
    }
    if (filters.temporary === 'true' || filters.temporary === 'false') {
      params.push(filters.temporary === 'true');
      where.push(`f.temporary = $${params.length}`);
    }
    const flags = await this.db.query<FlagRow>(
      `SELECT f.* FROM flags f WHERE ${where.join(' AND ')} ORDER BY f.created_at DESC`,
      params,
    );
    const configs = await this.db.query<ConfigRow & { last_evaluated_at: Date | null }>(
      `SELECT fc.*, ls.last_evaluated_at FROM flag_configs fc
       JOIN flags f ON f.id = fc.flag_id
       LEFT JOIN flag_last_seen ls ON ls.env_id = fc.env_id AND ls.flag_key = f.key
       WHERE f.project_id = $1`,
      [project.id],
    );
    const byFlag = new Map<string, typeof configs>();
    for (const config of configs) {
      const list = byFlag.get(config.flag_id) ?? [];
      list.push(config);
      byFlag.set(config.flag_id, list);
    }
    const items = flags.map((flag) => {
      const environments: FlagListItem['environments'] = {};
      for (const env of envs) {
        const config = byFlag.get(flag.id)?.find((c) => c.env_id === env.id);
        if (!config) continue;
        environments[env.key] = {
          on: config.on,
          version: config.version,
          lastEvaluatedAt: iso(config.last_evaluated_at),
          stale: isStale(flag.created_at, config.last_evaluated_at),
          fallthrough: config.fallthrough,
          rulesCount: config.rules.length,
        };
      }
      const envStates = Object.values(environments);
      return {
        ...toFlag(flag),
        environments,
        stale: envStates.length > 0 && envStates.every((e) => e.stale),
      };
    });
    if (filters.stale === 'true') return items.filter((i) => i.stale);
    if (filters.stale === 'false') return items.filter((i) => !i.stale);
    return items;
  }

  defaultVariations(input: z.infer<typeof createFlagSchema>): Variation[] {
    if (input.variations) return input.variations;
    if (input.kind === 'boolean') {
      return [
        { id: 'on', value: true, name: 'On' },
        { id: 'off', value: false, name: 'Off' },
      ];
    }
    throw badRequest(`variations are required for ${input.kind} flags`);
  }

  validateVariations(kind: FlagRow['kind'], variations: Variation[]): void {
    const ids = new Set<string>();
    for (const variation of variations) {
      if (ids.has(variation.id)) throw badRequest(`duplicate variation id ${variation.id}`);
      ids.add(variation.id);
      const value = variation.value;
      const ok =
        kind === 'boolean'
          ? typeof value === 'boolean'
          : kind === 'string'
            ? typeof value === 'string'
            : kind === 'number'
              ? typeof value === 'number' && Number.isFinite(value)
              : value !== undefined;
      if (!ok) throw badRequest(`variation ${variation.id} value does not match kind ${kind}`);
    }
  }

  async validatePrerequisites(
    sql: Sql,
    projectId: string,
    flagKey: string,
    prerequisites: Prerequisite[],
  ): Promise<void> {
    if (prerequisites.length === 0) return;
    const rows = await sql.query<{ key: string; variations: Variation[]; prerequisites: Prerequisite[] }>(
      'SELECT key, variations, prerequisites FROM flags WHERE project_id = $1',
      [projectId],
    );
    const graph = new Map(rows.map((r) => [r.key, r.prerequisites ?? []]));
    graph.set(flagKey, prerequisites);
    for (const prereq of prerequisites) {
      const target = rows.find((r) => r.key === prereq.flagKey);
      if (!target) throw unprocessable(`prerequisite flag ${prereq.flagKey} does not exist`);
      if (!target.variations.some((v) => v.id === prereq.variationId)) {
        throw unprocessable(`prerequisite flag ${prereq.flagKey} has no variation ${prereq.variationId}`);
      }
    }
    const visiting = new Set<string>();
    const visit = (key: string, path: string[]) => {
      if (visiting.has(key)) throw unprocessable(`prerequisite cycle: ${[...path, key].join(' → ')}`);
      visiting.add(key);
      for (const p of graph.get(key) ?? []) visit(p.flagKey, [...path, key]);
      visiting.delete(key);
    };
    visit(flagKey, []);
  }

  async create(project: ProjectCtx, input: z.infer<typeof createFlagSchema>, actor: Actor): Promise<FlagDto> {
    const variations = this.defaultVariations(input);
    this.validateVariations(input.kind, variations);
    const onVariation = input.defaultOnVariation ?? variations[0]!.id;
    const offVariation = input.defaultOffVariation ?? variations[variations.length - 1]!.id;
    if (!variations.some((v) => v.id === onVariation) || !variations.some((v) => v.id === offVariation)) {
      throw badRequest('default variations must reference existing variation ids');
    }
    const { flag } = await this.db.tx(async (sql) => {
      await this.validatePrerequisites(sql, project.id, input.key, input.prerequisites ?? []);
      const flag = await sql.one<FlagRow>(
        `INSERT INTO flags (project_id, key, name, description, kind, variations, tags, temporary, salt, prerequisites, client_side_available, maintainer_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          project.id,
          input.key,
          input.name,
          input.description ?? null,
          input.kind,
          JSON.stringify(variations),
          input.tags,
          input.temporary,
          randomSalt(),
          JSON.stringify(input.prerequisites ?? []),
          input.clientSideAvailable,
          input.maintainerId ?? actor.id,
        ],
      );
      const envs = await this.access.envs(project.id, sql);
      const versions: Array<{ env: EnvRow; version: number }> = [];
      for (const env of envs) {
        await sql.query(
          `INSERT INTO flag_configs (flag_id, env_id, "on", off_variation, fallthrough, updated_by) VALUES ($1, $2, false, $3, $4, $5)`,
          [flag.id, env.id, offVariation, JSON.stringify({ variation: onVariation }), actor.id],
        );
        const version = await bumpEnvVersion(sql, env.id);
        versions.push({ env, version });
        await this.changes.notifyFlag(sql, project, env, input.key, 1, version, actor);
      }
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        actor,
        action: 'flag.created',
        resource: `flag/${flag.key}`,
        after: toFlag(flag),
        descriptions: [`created ${flag.kind} flag ${flag.key}`],
      });
      return { flag, envs: versions };
    });
    this.webhooks.emit({
      orgId: project.orgId,
      projectId: project.id,
      projectKey: project.key,
      event: 'flag.created',
      text: `created flag ${flag.key}`,
      actor,
      data: { flag: toFlag(flag) },
    });
    return toFlag(flag);
  }

  async get(
    project: ProjectCtx,
    key: string,
  ): Promise<FlagDto & { environments: Record<string, FlagConfigDto> }> {
    const flag = await this.flagRow(project.id, key);
    const rows = await this.db.query<
      ConfigRow & { env_key: string; exp_id: string | null; exp_key: string | null }
    >(
      `SELECT fc.*, e.key AS env_key, x.id AS exp_id, x.key AS exp_key FROM flag_configs fc
       JOIN environments e ON e.id = fc.env_id
       LEFT JOIN experiments x ON x.flag_id = fc.flag_id AND x.env_id = fc.env_id AND x.status = 'running'
       WHERE fc.flag_id = $1 ORDER BY e.sort_order, e.created_at`,
      [flag.id],
    );
    const environments: Record<string, FlagConfigDto> = {};
    for (const row of rows) {
      environments[row.env_key] = toConfig(
        row,
        flag.key,
        row.env_key,
        row.exp_id ? { id: row.exp_id, key: row.exp_key! } : null,
      );
    }
    return { ...toFlag(flag), environments };
  }

  async getConfig(project: ProjectCtx, key: string, envKey: string): Promise<FlagConfigDto> {
    const flag = await this.flagRow(project.id, key);
    const env = await this.access.env(project, envKey);
    const row = await this.db.maybe<ConfigRow>(
      'SELECT * FROM flag_configs WHERE flag_id = $1 AND env_id = $2',
      [flag.id, env.id],
    );
    if (!row) throw notFound(`flag ${key} in ${envKey}`);
    return toConfig(row, flag.key, env.key, await this.changes.runningExperiment(this.db, flag.id, env.id));
  }

  async update(project: ProjectCtx, key: string, input: UpdateFlagInput, actor: Actor): Promise<FlagDto> {
    const result = await this.db.tx(async (sql) => {
      const before = await sql.maybe<FlagRow>(
        'SELECT * FROM flags WHERE project_id = $1 AND key = $2 FOR UPDATE',
        [project.id, key],
      );
      if (!before) throw notFound(`flag ${key}`);
      const variations = input.variations ?? before.variations;
      if (input.variations) {
        this.validateVariations(before.kind, variations);
        const ids = new Set(variations.map((v) => v.id));
        const removed = before.variations.filter((v) => !ids.has(v.id)).map((v) => v.id);
        if (removed.length > 0) {
          const configs = await sql.query<ConfigRow>('SELECT * FROM flag_configs WHERE flag_id = $1', [
            before.id,
          ]);
          const used = configs.some((c) => {
            const text = JSON.stringify([c.off_variation, c.targets, c.rules, c.fallthrough]);
            return removed.some((id) => text.includes(`"${id}"`));
          });
          if (used) throw unprocessable(`variations ${removed.join(', ')} are still used by targeting`);
        }
      }
      if (input.prerequisites) await this.validatePrerequisites(sql, project.id, key, input.prerequisites);
      const archivedAt =
        input.archived === undefined
          ? before.archived_at
          : input.archived
            ? (before.archived_at ?? new Date())
            : null;
      const after = await sql.one<FlagRow>(
        `UPDATE flags SET name = $2, description = $3, tags = $4, temporary = $5, client_side_available = $6,
           prerequisites = $7, maintainer_id = $8, variations = $9, archived_at = $10, version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          before.id,
          input.name ?? before.name,
          input.description ?? before.description,
          input.tags ?? before.tags,
          input.temporary ?? before.temporary,
          input.clientSideAvailable ?? before.client_side_available,
          JSON.stringify(input.prerequisites ?? before.prerequisites),
          input.maintainerId === undefined ? before.maintainer_id : input.maintainerId,
          JSON.stringify(variations),
          archivedAt,
        ],
      );
      const envs = await this.access.envs(project.id, sql);
      const versions: Array<{ env: EnvRow; version: number }> = [];
      for (const env of envs) {
        const version = await bumpEnvVersion(sql, env.id);
        versions.push({ env, version });
        await this.changes.notifyFlag(sql, project, env, key, after.version, version, actor);
      }
      const action =
        input.archived === true && !before.archived_at
          ? 'flag.archived'
          : input.archived === false && before.archived_at
            ? 'flag.restored'
            : 'flag.updated';
      const diff = jsonDiff(toFlag(before), toFlag(after)).filter(
        (d) => !['/version', '/updatedAt'].includes(d.path),
      );
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        actor,
        action,
        resource: `flag/${key}`,
        before: toFlag(before),
        after: toFlag(after),
        descriptions: diff.map((d) => `${d.op} ${d.path}`),
      });
      return { after, versions, action };
    });
    this.webhooks.emit({
      orgId: project.orgId,
      projectId: project.id,
      projectKey: project.key,
      event: result.action === 'flag.archived' ? 'flag.archived' : 'flag.updated',
      text: `${result.action === 'flag.archived' ? 'archived' : 'updated'} flag ${key}`,
      actor,
      data: { flag: toFlag(result.after) },
    });
    return toFlag(result.after);
  }

  async remove(project: ProjectCtx, key: string, actor: Actor): Promise<void> {
    await this.db.tx(async (sql) => {
      const flag = await sql.maybe<FlagRow>(
        'SELECT * FROM flags WHERE project_id = $1 AND key = $2 FOR UPDATE',
        [project.id, key],
      );
      if (!flag) throw notFound(`flag ${key}`);
      if (!flag.archived_at) throw conflict('archive the flag before deleting it');
      const dependents = await sql.query<{ key: string }>(
        `SELECT key FROM flags WHERE project_id = $1 AND prerequisites @> $2::jsonb`,
        [project.id, JSON.stringify([{ flagKey: key }])],
      );
      if (dependents.length > 0)
        throw conflict(`flag is a prerequisite of ${dependents.map((d) => d.key).join(', ')}`);
      await sql.query('DELETE FROM flags WHERE id = $1', [flag.id]);
      const envs = await this.access.envs(project.id, sql);
      const out: Array<{ env: EnvRow; version: number }> = [];
      for (const env of envs) {
        const version = await bumpEnvVersion(sql, env.id);
        out.push({ env, version });
        await this.changes.notifyFlag(sql, project, env, key, 0, version, actor);
      }
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        actor,
        action: 'flag.deleted',
        resource: `flag/${key}`,
        before: toFlag(flag),
        descriptions: [`deleted flag ${key}`],
      });
      return out;
    });
  }

  async copyPreview(
    project: ProjectCtx,
    key: string,
    source: string,
    target: string,
    includeTargets: boolean,
  ) {
    if (source === target) throw badRequest('source and target environments must differ');
    const from = await this.getConfig(project, key, source);
    const to = await this.getConfig(project, key, target);
    const desired = patchable(from);
    if (!includeTargets) desired.targets = to.targets;
    const instructions = instructionsBetween(patchable(to), desired);
    return { source: from, target: to, instructions, diff: jsonDiff(patchable(to), desired) };
  }

  async compare(project: ProjectCtx, envKeys: string[]) {
    const envs = (await this.access.envs(project.id)).filter(
      (e) => envKeys.length === 0 || envKeys.includes(e.key),
    );
    const flags = await this.db.query<FlagRow>(
      'SELECT * FROM flags WHERE project_id = $1 AND archived_at IS NULL ORDER BY key',
      [project.id],
    );
    const configs = await this.db.query<ConfigRow>(
      'SELECT fc.* FROM flag_configs fc JOIN flags f ON f.id = fc.flag_id WHERE f.project_id = $1',
      [project.id],
    );
    const base = envs[0];
    return {
      environments: envs.map((e) => ({ key: e.key, name: e.name, color: e.color })),
      flags: flags.map((flag) => {
        const cells: Record<
          string,
          { on: boolean; version: number; config: unknown; differsFromFirst: boolean; diff: unknown[] }
        > = {};
        const baseRow = base ? configs.find((c) => c.flag_id === flag.id && c.env_id === base.id) : undefined;
        const baseConfig = baseRow ? patchable(toConfig(baseRow, flag.key, base!.key)) : null;
        for (const env of envs) {
          const row = configs.find((c) => c.flag_id === flag.id && c.env_id === env.id);
          if (!row) continue;
          const config = patchable(toConfig(row, flag.key, env.key));
          const diff = baseConfig ? jsonDiff(baseConfig, config) : [];
          cells[env.key] = {
            on: row.on,
            version: row.version,
            config,
            differsFromFirst: diff.length > 0,
            diff,
          };
        }
        return {
          key: flag.key,
          name: flag.name,
          kind: flag.kind,
          environments: cells,
          identical: Object.values(cells).every((c) => !c.differsFromFirst),
        };
      }),
    };
  }

  async ruleset(project: ProjectCtx, envKey: string) {
    const env = await this.access.env(project, envKey);
    const rows = await this.db.query<
      FlagRow & { config: ConfigRow; exp_id: string | null; exp_key: string | null }
    >(
      `SELECT f.*, row_to_json(fc.*) AS config, x.id AS exp_id, x.key AS exp_key FROM flags f
       JOIN flag_configs fc ON fc.flag_id = f.id AND fc.env_id = $2
       LEFT JOIN experiments x ON x.flag_id = f.id AND x.env_id = $2 AND x.status = 'running'
       WHERE f.project_id = $1 AND f.archived_at IS NULL`,
      [project.id, env.id],
    );
    const segments = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM segments WHERE env_id = $1',
      [env.id],
    );
    const flags: Record<string, unknown> = {};
    for (const row of rows) {
      const flag = toFlag(row);
      flags[row.key] = {
        key: flag.key,
        name: flag.name,
        kind: flag.kind,
        variations: flag.variations,
        salt: flag.salt,
        prerequisites: flag.prerequisites,
        clientSideAvailable: flag.clientSideAvailable,
        config: toConfig(
          row.config,
          row.key,
          env.key,
          row.exp_id ? { id: row.exp_id, key: row.exp_key! } : null,
        ),
      };
    }
    const segs: Record<string, unknown> = {};
    for (const s of segments) {
      segs[String(s.key)] = {
        key: s.key,
        name: s.name,
        contextKind: s.context_kind,
        included: s.included,
        excluded: s.excluded,
        rules: s.rules,
        version: s.version,
      };
    }
    return { env: env.key, version: env.version, flags, segments: segs };
  }

  async contextAttributes(project: ProjectCtx, envKey?: string) {
    const params: unknown[] = [project.id];
    let envFilter = '';
    if (envKey) {
      params.push(envKey);
      envFilter = 'AND e.key = $2';
    }
    return this.db.query<{ kind: string; name: string; last_seen_at: Date }>(
      `SELECT DISTINCT ON (ca.kind, ca.name) ca.kind, ca.name, ca.last_seen_at FROM context_attributes ca
       JOIN environments e ON e.id = ca.env_id WHERE e.project_id = $1 ${envFilter}
       ORDER BY ca.kind, ca.name, ca.last_seen_at DESC`,
      params,
    );
  }
}

export type { CreateFlagInput };
