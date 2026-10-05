import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  applyInstructions,
  describeInstruction,
  PatchError,
  type Instruction,
} from '@ashamrai/flags-contracts';
import { AccessService, type ProjectCtx } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/auth';
import { badRequest, conflict, notFound, unprocessable } from '../common/errors';
import { iso } from '../db/db';
import { ensurePartitions } from '../db/migrate';
import { ChangesService, type Actor } from '../flags/changes.service';
import { FlagsService } from '../flags/flags.service';
import { patchable } from '../flags/model';
import { Database } from '../infra/database';

interface ScheduledRow {
  id: string;
  flag_id: string;
  env_id: string;
  instructions: Instruction[];
  execute_at: Date;
  status: string;
  comment: string | null;
  author_id: string | null;
  author_name: string | null;
  error: string | null;
  created_at: Date;
  executed_at: Date | null;
  flag_key: string;
  env_key: string;
  project_id: string;
  project_key: string;
  org_id: string;
  variations: Array<{ id: string; value: unknown; name?: string }>;
}

const SELECT = `SELECT sc.*, f.key AS flag_key, f.variations, e.key AS env_key, p.id AS project_id, p.key AS project_key, p.org_id, u.name AS author_name
  FROM scheduled_changes sc
  JOIN flags f ON f.id = sc.flag_id
  JOIN environments e ON e.id = sc.env_id
  JOIN projects p ON p.id = f.project_id
  LEFT JOIN users u ON u.id = sc.author_id`;

function toDto(row: ScheduledRow) {
  return {
    id: row.id,
    flagKey: row.flag_key,
    envKey: row.env_key,
    instructions: row.instructions,
    descriptions: row.instructions.map((i) => describeInstruction(i, { variations: row.variations })),
    executeAt: iso(row.execute_at),
    status: row.status,
    comment: row.comment,
    author: row.author_id ? { id: row.author_id, name: row.author_name } : null,
    error: row.error,
    createdAt: iso(row.created_at),
    executedAt: iso(row.executed_at),
  };
}

@Injectable()
export class ScheduledService implements OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private lastPartitionCheck = 0;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(FlagsService) private readonly flags: FlagsService,
    @Inject(ChangesService) private readonly changes: ChangesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(
    project: ProjectCtx,
    flagKey: string,
    envKey: string,
    instructions: Instruction[],
    executeAt: string,
    comment: string | undefined,
    actor: Actor,
  ) {
    const when = new Date(executeAt);
    if (Number.isNaN(when.getTime())) throw badRequest('executeAt is not a valid date');
    const flag = await this.flags.flagRow(project.id, flagKey);
    const env = await this.access.env(project, envKey);
    const config = await this.flags.getConfig(project, flagKey, envKey);
    try {
      applyInstructions(patchable(config), instructions, { variations: flag.variations });
    } catch (error) {
      if (error instanceof PatchError) throw unprocessable(error.message, { index: error.index });
      throw error;
    }
    const row = await this.db.tx(async (sql) => {
      const created = await sql.one<{ id: string }>(
        `INSERT INTO scheduled_changes (flag_id, env_id, instructions, execute_at, status, comment, author_id)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6) RETURNING id`,
        [flag.id, env.id, JSON.stringify(instructions), when, comment ?? null, actor.id],
      );
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        envId: env.id,
        actor,
        action: 'scheduled_change.created',
        resource: `flag/${flagKey}/env/${envKey}/schedule/${created.id}`,
        instructions,
        descriptions: [
          `scheduled for ${when.toISOString()}`,
          ...instructions.map((i) => describeInstruction(i, { variations: flag.variations })),
        ],
        comment: comment ?? null,
      });
      return created;
    });
    return this.byId(row.id);
  }

  async byId(id: string) {
    const row = await this.db.maybe<ScheduledRow>(`${SELECT} WHERE sc.id = $1`, [id]);
    if (!row) throw notFound('scheduled change');
    return toDto(row);
  }

  async list(project: ProjectCtx, status?: string) {
    const params: unknown[] = [project.id];
    let filter = '';
    if (status) {
      params.push(status);
      filter = ' AND sc.status = $2';
    }
    return (
      await this.db.query<ScheduledRow>(
        `${SELECT} WHERE p.id = $1${filter} ORDER BY sc.execute_at DESC LIMIT 200`,
        params,
      )
    ).map(toDto);
  }

  async cancel(user: AuthUser, id: string) {
    const row = await this.db.maybe<ScheduledRow>(`${SELECT} WHERE sc.id = $1`, [id]);
    if (!row) throw notFound('scheduled change');
    const project = await this.access.project(user, row.project_key, 'writer');
    const updated = await this.db.query(
      "UPDATE scheduled_changes SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING id",
      [id],
    );
    if (updated.length === 0) throw conflict(`scheduled change is ${row.status}`);
    await this.audit.record(this.db, {
      orgId: project.orgId,
      projectId: project.id,
      envId: row.env_id,
      actor: { id: user.id, name: user.name },
      action: 'scheduled_change.cancelled',
      resource: `flag/${row.flag_key}/env/${row.env_key}/schedule/${id}`,
    });
    return this.byId(id);
  }

  async runDue(limit = 20): Promise<number> {
    const posts: Array<() => Promise<void>> = [];
    const executed = await this.db.tx(async (sql) => {
      const due = await sql.query<ScheduledRow>(
        `${SELECT} WHERE sc.status = 'pending' AND sc.execute_at <= now()
         ORDER BY sc.execute_at LIMIT $1 FOR UPDATE OF sc SKIP LOCKED`,
        [limit],
      );
      for (const change of due) {
        await sql.query('SAVEPOINT scheduled_change');
        try {
          const { post } = await this.changes.patchInTx(sql, {
            project: { id: change.project_id, key: change.project_key, orgId: change.org_id },
            flagKey: change.flag_key,
            envKey: change.env_key,
            instructions: change.instructions,
            actor: change.author_id
              ? { id: change.author_id, name: change.author_name ?? 'scheduler' }
              : null,
            comment: change.comment ?? `scheduled change ${change.id}`,
            action: 'scheduled_change.executed',
          });
          await sql.query(
            "UPDATE scheduled_changes SET status = 'executed', executed_at = now() WHERE id = $1",
            [change.id],
          );
          await sql.query('RELEASE SAVEPOINT scheduled_change');
          posts.push(post);
        } catch (error) {
          await sql.query('ROLLBACK TO SAVEPOINT scheduled_change');
          await sql.query(
            "UPDATE scheduled_changes SET status = 'failed', error = $2, executed_at = now() WHERE id = $1",
            [change.id, error instanceof Error ? error.message : String(error)],
          );
        }
      }
      return due.length;
    });
    for (const post of posts) await post();
    return executed;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.tick().finally(() => {
        this.running = null;
      });
    }, intervalMs);
    this.timer.unref();
  }

  private async tick(): Promise<number> {
    try {
      if (Date.now() - this.lastPartitionCheck > 3600000) {
        this.lastPartitionCheck = Date.now();
        await ensurePartitions(this.db);
      }
      return await this.runDue();
    } catch {
      return 0;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running;
  }
}
