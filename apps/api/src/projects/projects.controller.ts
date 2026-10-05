import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  createEnvironmentSchema,
  createProjectSchema,
  updateEnvironmentSchema,
  updateProjectSchema,
} from '@ashamrai/flags-contracts';
import type { z } from 'zod';
import { AccessService, bumpEnvVersion, type EnvRow } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { badRequest, conflict, notFound } from '../common/errors';
import { actorOf } from '../common/http';
import { ZBody } from '../common/zod';
import type { Sql } from '../db/db';
import { ChangesService } from '../flags/changes.service';
import { Database } from '../infra/database';

export const DEFAULT_ENVIRONMENTS = [
  { key: 'development', name: 'Development', color: '#22c55e' },
  { key: 'staging', name: 'Staging', color: '#f59e0b' },
  { key: 'production', name: 'Production', color: '#ef4444' },
];

export function toEnv(row: EnvRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    color: row.color,
    requireApproval: row.require_approval,
    version: row.version,
    sortOrder: row.sort_order,
  };
}

async function createEnvironment(
  sql: Sql,
  projectId: string,
  input: { key: string; name: string; color: string; requireApproval: boolean },
  sortOrder: number,
): Promise<EnvRow> {
  const env = await sql.one<EnvRow>(
    `INSERT INTO environments (project_id, key, name, color, require_approval, sort_order) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [projectId, input.key, input.name, input.color, input.requireApproval, sortOrder],
  );
  await sql.query(
    `INSERT INTO flag_configs (flag_id, env_id, "on", off_variation, fallthrough)
     SELECT f.id, $2, false, f.variations -> (jsonb_array_length(f.variations) - 1) ->> 'id', jsonb_build_object('variation', f.variations -> 0 ->> 'id')
     FROM flags f WHERE f.project_id = $1`,
    [projectId, env.id],
  );
  return env;
}

@Controller('projects')
export class ProjectsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ChangesService) private readonly changes: ChangesService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const projects = await this.db.query<{
      id: string;
      key: string;
      name: string;
      org_id: string;
      org_name: string;
      role: string;
    }>(
      `SELECT p.id, p.key, p.name, p.org_id, o.name AS org_name, m.role FROM projects p
       JOIN organizations o ON o.id = p.org_id
       JOIN org_members m ON m.org_id = p.org_id AND m.user_id = $1 ORDER BY p.created_at`,
      [user.id],
    );
    const envs = await this.db.query<EnvRow>(
      'SELECT * FROM environments WHERE project_id = ANY($1::uuid[]) ORDER BY sort_order, created_at',
      [projects.map((p) => p.id)],
    );
    return {
      items: projects.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        organization: { id: p.org_id, name: p.org_name },
        role: p.role,
        environments: envs.filter((e) => e.project_id === p.id).map(toEnv),
      })),
    };
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @ZBody(createProjectSchema) body: z.infer<typeof createProjectSchema>,
  ) {
    let orgId = body.organizationId;
    if (!orgId) {
      const first = await this.db.maybe<{ org_id: string }>(
        "SELECT org_id FROM org_members WHERE user_id = $1 AND role IN ('admin', 'writer') ORDER BY created_at LIMIT 1",
        [user.id],
      );
      if (!first) throw badRequest('no organization available');
      orgId = first.org_id;
    }
    await this.access.orgRole(user, orgId, 'writer');
    const envDefs = body.environments ?? DEFAULT_ENVIRONMENTS;
    return this.db.tx(async (sql) => {
      const project = await sql.one<{ id: string; key: string; name: string }>(
        'INSERT INTO projects (org_id, key, name) VALUES ($1, $2, $3) RETURNING id, key, name',
        [orgId, body.key, body.name],
      );
      const envs: EnvRow[] = [];
      for (const [index, env] of envDefs.entries()) {
        envs.push(
          await createEnvironment(
            sql,
            project.id,
            { key: env.key, name: env.name, color: env.color ?? '#64748b', requireApproval: false },
            index,
          ),
        );
      }
      await this.audit.record(sql, {
        orgId: orgId!,
        projectId: project.id,
        actor: actorOf(user),
        action: 'project.created',
        resource: `project/${project.key}`,
        after: project,
      });
      return { ...project, organizationId: orgId, environments: envs.map(toEnv) };
    });
  }

  @Get(':p')
  async get(@CurrentUser() user: AuthUser, @Param('p') p: string) {
    const project = await this.access.project(user, p);
    return {
      id: project.id,
      key: project.key,
      name: project.name,
      organizationId: project.orgId,
      role: project.role,
      environments: (await this.access.envs(project.id)).map(toEnv),
    };
  }

  @Patch(':p')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @ZBody(updateProjectSchema) body: z.infer<typeof updateProjectSchema>,
  ) {
    const project = await this.access.project(user, p, 'admin');
    await this.db.query('UPDATE projects SET name = $2 WHERE id = $1', [project.id, body.name]);
    await this.audit.record(this.db, {
      orgId: project.orgId,
      projectId: project.id,
      actor: actorOf(user),
      action: 'project.updated',
      resource: `project/${p}`,
      before: { name: project.name },
      after: { name: body.name },
    });
    return { ...project, name: body.name };
  }

  @Delete(':p')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('p') p: string) {
    const project = await this.access.project(user, p, 'admin');
    await this.db.query('DELETE FROM projects WHERE id = $1', [project.id]);
    await this.audit.record(this.db, {
      orgId: project.orgId,
      actor: actorOf(user),
      action: 'project.deleted',
      resource: `project/${p}`,
    });
  }

  @Get(':p/environments')
  async envs(@CurrentUser() user: AuthUser, @Param('p') p: string) {
    const project = await this.access.project(user, p);
    return { items: (await this.access.envs(project.id)).map(toEnv) };
  }

  @Post(':p/environments')
  async createEnv(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @ZBody(createEnvironmentSchema) body: z.infer<typeof createEnvironmentSchema>,
  ) {
    const project = await this.access.project(user, p, 'admin');
    return this.db.tx(async (sql) => {
      const count = await sql.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM environments WHERE project_id = $1',
        [project.id],
      );
      const env = await createEnvironment(sql, project.id, body, count.n);
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        envId: env.id,
        actor: actorOf(user),
        action: 'environment.created',
        resource: `env/${env.key}`,
        after: toEnv(env),
      });
      return toEnv(env);
    });
  }

  @Patch(':p/environments/:env')
  async updateEnv(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('env') envKey: string,
    @ZBody(updateEnvironmentSchema) body: z.infer<typeof updateEnvironmentSchema>,
  ) {
    const project = await this.access.project(user, p, 'admin');
    const before = await this.access.env(project, envKey);
    const { env } = await this.db.tx(async (sql) => {
      const env = await sql.one<EnvRow>(
        `UPDATE environments SET name = coalesce($2, name), color = coalesce($3, color), require_approval = coalesce($4, require_approval)
         WHERE id = $1 RETURNING *`,
        [before.id, body.name ?? null, body.color ?? null, body.requireApproval ?? null],
      );
      const version = await bumpEnvVersion(sql, env.id);
      await this.changes.notifyEnv(sql, project, env, version, actorOf(user));
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        envId: env.id,
        actor: actorOf(user),
        action: 'environment.updated',
        resource: `env/${env.key}`,
        before: toEnv(before),
        after: toEnv(env),
      });
      return { env: { ...env, version }, version };
    });
    return toEnv(env);
  }

  @Delete(':p/environments/:env')
  @HttpCode(204)
  async removeEnv(@CurrentUser() user: AuthUser, @Param('p') p: string, @Param('env') envKey: string) {
    const project = await this.access.project(user, p, 'admin');
    const env = await this.access.env(project, envKey);
    const remaining = await this.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM environments WHERE project_id = $1',
      [project.id],
    );
    if (remaining.n <= 1) throw conflict('a project needs at least one environment');
    const deleted = await this.db.query('DELETE FROM environments WHERE id = $1 RETURNING id', [env.id]);
    if (deleted.length === 0) throw notFound('environment');
    await this.audit.record(this.db, {
      orgId: project.orgId,
      projectId: project.id,
      actor: actorOf(user),
      action: 'environment.deleted',
      resource: `env/${envKey}`,
    });
  }
}
