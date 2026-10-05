import { Inject, Injectable } from '@nestjs/common';
import type { Role } from '@ashamrai/flags-contracts';
import type { AuthUser } from '../common/auth';
import { forbidden, notFound } from '../common/errors';
import type { Sql } from '../db/db';
import { Database } from '../infra/database';

export interface ProjectCtx {
  id: string;
  key: string;
  name: string;
  orgId: string;
  role: Role;
}

export interface EnvRow {
  id: string;
  project_id: string;
  key: string;
  name: string;
  color: string;
  require_approval: boolean;
  version: number;
  sort_order: number;
}

const RANK: Record<Role, number> = { reader: 0, writer: 1, admin: 2 };

export function hasRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

@Injectable()
export class AccessService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async orgRole(user: AuthUser, orgId: string, min: Role = 'reader'): Promise<Role> {
    const row = await this.db.maybe<{ role: Role }>(
      'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, user.id],
    );
    if (!row) throw notFound('organization');
    if (!hasRole(row.role, min)) throw forbidden();
    return row.role;
  }

  async project(user: AuthUser, projectKey: string, min: Role = 'reader'): Promise<ProjectCtx> {
    const row = await this.db.maybe<{ id: string; key: string; name: string; org_id: string; role: Role }>(
      `SELECT p.id, p.key, p.name, p.org_id, m.role FROM projects p
       JOIN org_members m ON m.org_id = p.org_id AND m.user_id = $2
       WHERE p.key = $1`,
      [projectKey, user.id],
    );
    if (!row) throw notFound(`project ${projectKey}`);
    if (!hasRole(row.role, min)) throw forbidden();
    return { id: row.id, key: row.key, name: row.name, orgId: row.org_id, role: row.role };
  }

  async env(project: ProjectCtx, envKey: string, sql: Sql = this.db): Promise<EnvRow> {
    const env = await sql.maybe<EnvRow>('SELECT * FROM environments WHERE project_id = $1 AND key = $2', [
      project.id,
      envKey,
    ]);
    if (!env) throw notFound(`environment ${envKey}`);
    return env;
  }

  async envs(projectId: string, sql: Sql = this.db): Promise<EnvRow[]> {
    return sql.query<EnvRow>(
      'SELECT * FROM environments WHERE project_id = $1 ORDER BY sort_order, created_at',
      [projectId],
    );
  }
}

export async function bumpEnvVersion(sql: Sql, envId: string): Promise<number> {
  const row = await sql.one<{ version: number }>(
    'UPDATE environments SET version = version + 1 WHERE id = $1 RETURNING version',
    [envId],
  );
  return row.version;
}
