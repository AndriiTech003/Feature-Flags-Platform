import { Inject, Injectable } from '@nestjs/common';
import {
  applyInstructions,
  describeInstruction,
  jsonDiff,
  PatchError,
  type Instruction,
} from '@ashamrai/flags-contracts';
import { AccessService, type ProjectCtx } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/auth';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { iso } from '../db/db';
import { ChangesService, type Actor } from '../flags/changes.service';
import { FlagsService } from '../flags/flags.service';
import { patchable } from '../flags/model';
import { Database } from '../infra/database';
import { WebhookDispatcher } from '../webhooks/dispatcher';

interface CrRow {
  id: string;
  flag_id: string;
  env_id: string;
  instructions: Instruction[];
  comment: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
  author_id: string | null;
  reviewer_id: string | null;
  review_comment: string | null;
  base_version: number;
  error: string | null;
  created_at: Date;
  reviewed_at: Date | null;
  applied_at: Date | null;
  flag_key: string;
  env_key: string;
  project_key: string;
  project_id: string;
  org_id: string;
  author_name: string | null;
  reviewer_name: string | null;
  variations: Array<{ id: string; value: unknown; name?: string }>;
}

const SELECT = `SELECT cr.*, f.key AS flag_key, f.variations, e.key AS env_key, p.key AS project_key, p.id AS project_id, p.org_id,
  a.name AS author_name, r.name AS reviewer_name
  FROM change_requests cr
  JOIN flags f ON f.id = cr.flag_id
  JOIN environments e ON e.id = cr.env_id
  JOIN projects p ON p.id = f.project_id
  LEFT JOIN users a ON a.id = cr.author_id
  LEFT JOIN users r ON r.id = cr.reviewer_id`;

function toDto(row: CrRow) {
  return {
    id: row.id,
    flagKey: row.flag_key,
    envKey: row.env_key,
    projectKey: row.project_key,
    instructions: row.instructions,
    descriptions: row.instructions.map((i) => describeInstruction(i, { variations: row.variations })),
    comment: row.comment,
    status: row.status,
    author: row.author_id ? { id: row.author_id, name: row.author_name } : null,
    reviewer: row.reviewer_id ? { id: row.reviewer_id, name: row.reviewer_name } : null,
    reviewComment: row.review_comment,
    baseVersion: row.base_version,
    error: row.error,
    createdAt: iso(row.created_at),
    reviewedAt: iso(row.reviewed_at),
    appliedAt: iso(row.applied_at),
  };
}

@Injectable()
export class ChangeRequestsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(FlagsService) private readonly flags: FlagsService,
    @Inject(ChangesService) private readonly changes: ChangesService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  async create(
    project: ProjectCtx,
    flagKey: string,
    envKey: string,
    instructions: Instruction[],
    comment: string | null | undefined,
    actor: Actor,
  ) {
    const flag = await this.flags.flagRow(project.id, flagKey);
    const env = await this.access.env(project, envKey);
    const config = await this.flags.getConfig(project, flagKey, envKey);
    try {
      applyInstructions(patchable(config), instructions, { variations: flag.variations });
    } catch (error) {
      if (error instanceof PatchError) throw unprocessable(error.message, { index: error.index });
      throw error;
    }
    const id = await this.db.tx(async (sql) => {
      const row = await sql.one<{ id: string }>(
        `INSERT INTO change_requests (flag_id, env_id, instructions, comment, status, author_id, base_version)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6) RETURNING id`,
        [flag.id, env.id, JSON.stringify(instructions), comment ?? null, actor.id, config.version],
      );
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        envId: env.id,
        actor,
        action: 'change_request.created',
        resource: `flag/${flagKey}/env/${envKey}/change-request/${row.id}`,
        instructions,
        descriptions: instructions.map((i) => describeInstruction(i, { variations: flag.variations })),
        comment: comment ?? null,
      });
      return row.id;
    });
    this.webhooks.emit({
      orgId: project.orgId,
      projectId: project.id,
      projectKey: project.key,
      envKey,
      event: 'change_request.created',
      text: `requested approval for ${flagKey}`,
      actor,
      data: { id, flagKey, instructions },
    });
    return this.byId(id);
  }

  async byId(id: string) {
    const row = await this.db.maybe<CrRow>(`${SELECT} WHERE cr.id = $1`, [id]);
    if (!row) throw notFound('change request');
    return toDto(row);
  }

  async rowFor(user: AuthUser, id: string, min: 'reader' | 'writer') {
    const row = await this.db.maybe<CrRow>(`${SELECT} WHERE cr.id = $1`, [id]);
    if (!row) throw notFound('change request');
    const project = await this.access.project(user, row.project_key, min);
    return { row, project };
  }

  async detail(user: AuthUser, id: string) {
    const { row, project } = await this.rowFor(user, id, 'reader');
    const current = await this.flags.getConfig(project, row.flag_key, row.env_key);
    let preview: unknown = null;
    let previewError: string | null = null;
    try {
      const after = applyInstructions(patchable(current), row.instructions, { variations: row.variations });
      preview = { before: patchable(current), after, diff: jsonDiff(patchable(current), after) };
    } catch (error) {
      previewError = error instanceof Error ? error.message : String(error);
    }
    return { ...toDto(row), currentVersion: current.version, preview, previewError };
  }

  async list(project: ProjectCtx, status?: string) {
    const params: unknown[] = [project.id];
    let filter = '';
    if (status) {
      params.push(status);
      filter = ` AND cr.status = $2`;
    }
    const rows = await this.db.query<CrRow>(
      `${SELECT} WHERE p.id = $1${filter} ORDER BY cr.created_at DESC LIMIT 200`,
      params,
    );
    return rows.map(toDto);
  }

  async review(user: AuthUser, id: string, decision: 'approved' | 'rejected', comment?: string) {
    const { row, project } = await this.rowFor(user, id, 'writer');
    if (row.status !== 'pending') throw conflict(`change request is ${row.status}`);
    if (decision === 'approved' && row.author_id === user.id)
      throw forbidden('authors cannot approve their own change requests');
    await this.db.tx(async (sql) => {
      const updated = await sql.query(
        `UPDATE change_requests SET status = $2, reviewer_id = $3, review_comment = $4, reviewed_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`,
        [id, decision, user.id, comment ?? null],
      );
      if (updated.length === 0) throw conflict('change request was already reviewed');
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        envId: row.env_id,
        actor: { id: user.id, name: user.name },
        action: `change_request.${decision}`,
        resource: `flag/${row.flag_key}/env/${row.env_key}/change-request/${id}`,
        comment: comment ?? null,
        descriptions: [`${decision} change request`],
      });
    });
    return this.byId(id);
  }

  async apply(user: AuthUser, id: string) {
    const { row, project } = await this.rowFor(user, id, 'writer');
    if (row.status !== 'approved')
      throw conflict(`change request must be approved before applying (status: ${row.status})`);
    try {
      const { post } = await this.db.tx(async (sql) => {
        const locked = await sql.query(
          "SELECT id FROM change_requests WHERE id = $1 AND status = 'approved' FOR UPDATE",
          [id],
        );
        if (locked.length === 0) throw conflict('change request is no longer approved');
        const result = await this.changes.patchInTx(sql, {
          project,
          flagKey: row.flag_key,
          envKey: row.env_key,
          instructions: row.instructions,
          actor: { id: user.id, name: user.name },
          comment: row.comment ?? `change request ${id}`,
          action: 'change_request.applied',
        });
        await sql.query("UPDATE change_requests SET status = 'applied', applied_at = now() WHERE id = $1", [
          id,
        ]);
        return result;
      });
      await post();
    } catch (error) {
      if (error instanceof PatchError) {
        await this.db.query("UPDATE change_requests SET status = 'failed', error = $2 WHERE id = $1", [
          id,
          error.message,
        ]);
        throw conflict(`change request no longer applies: ${error.message}`);
      }
      throw error;
    }
    this.webhooks.emit({
      orgId: project.orgId,
      projectId: project.id,
      projectKey: project.key,
      envKey: row.env_key,
      event: 'change_request.applied',
      text: `applied change request for ${row.flag_key}`,
      actor: { id: user.id, name: user.name },
      data: { id, flagKey: row.flag_key },
    });
    return this.byId(id);
  }
}
