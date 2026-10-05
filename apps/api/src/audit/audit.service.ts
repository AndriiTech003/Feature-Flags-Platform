import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from '../db/db';
import { iso } from '../db/db';
import { Database } from '../infra/database';

export interface AuditEntry {
  orgId: string;
  projectId?: string | null;
  envId?: string | null;
  actor?: { id: string; name: string } | null;
  action: string;
  resource: string;
  before?: unknown;
  after?: unknown;
  instructions?: unknown;
  descriptions?: string[];
  comment?: string | null;
}

export interface AuditRecord {
  id: number;
  action: string;
  resource: string;
  envKey: string | null;
  actor: { id: string | null; name: string | null };
  before: unknown;
  after: unknown;
  instructions: unknown;
  descriptions: string[];
  comment: string | null;
  createdAt: string;
}

@Injectable()
export class AuditService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async record(sql: Sql, entry: AuditEntry): Promise<void> {
    await sql.query(
      `INSERT INTO audit_log (org_id, project_id, env_id, actor_id, actor_name, action, resource, before, after, instructions, descriptions, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        entry.orgId,
        entry.projectId ?? null,
        entry.envId ?? null,
        entry.actor?.id ?? null,
        entry.actor?.name ?? 'system',
        entry.action,
        entry.resource,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.instructions === undefined ? null : JSON.stringify(entry.instructions),
        entry.descriptions ?? [],
        entry.comment ?? null,
      ],
    );
  }

  async list(
    projectId: string,
    filters: {
      env?: string;
      resource?: string;
      action?: string;
      actor?: string;
      limit: number;
      before?: string;
    },
  ): Promise<AuditRecord[]> {
    const where = ['a.project_id = $1'];
    const params: unknown[] = [projectId];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (filters.env) add('e.key = ?', filters.env);
    if (filters.resource) add('a.resource LIKE ?', `%${filters.resource}%`);
    if (filters.action) add('a.action = ?', filters.action);
    if (filters.actor)
      add('(a.actor_name ILIKE ? OR a.actor_id::text = $' + (params.length + 1) + ')', `%${filters.actor}%`);
    if (filters.actor) params.push(filters.actor);
    if (filters.before) add('a.id < ?', Number(filters.before));
    params.push(filters.limit);
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT a.*, e.key AS env_key FROM audit_log a LEFT JOIN environments e ON e.id = a.env_id
       WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      action: String(r.action),
      resource: String(r.resource),
      envKey: (r.env_key as string | null) ?? null,
      actor: { id: (r.actor_id as string | null) ?? null, name: (r.actor_name as string | null) ?? null },
      before: r.before,
      after: r.after,
      instructions: r.instructions,
      descriptions: (r.descriptions as string[]) ?? [],
      comment: (r.comment as string | null) ?? null,
      createdAt: iso(r.created_at)!,
    }));
  }
}
