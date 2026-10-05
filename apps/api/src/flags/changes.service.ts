import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  applyInstructions,
  describeInstruction,
  jsonDiff,
  ruleSchema,
  serveSchema,
  targetSchema,
  type ChangeNotification,
  type Instruction,
} from '@ashamrai/flags-contracts';
import { AuditService } from '../audit/audit.service';
import { conflict, notFound, unprocessable } from '../common/errors';
import type { Sql } from '../db/db';
import { bumpEnvVersion, type EnvRow } from '../access/access.service';
import { Database } from '../infra/database';
import { enqueueOutbox } from '../outbox/outbox';
import { WebhookDispatcher } from '../webhooks/dispatcher';
import { toConfig, type ConfigRow, type FlagConfigDto, type FlagRow } from './model';

export interface Actor {
  id: string;
  name: string;
}

export interface ProjectRef {
  id: string;
  key: string;
  orgId: string;
}

export interface PatchInput {
  project: ProjectRef;
  flagKey: string;
  envKey: string;
  instructions: Instruction[];
  actor: Actor | null;
  expectedVersion?: number | null;
  comment?: string | null;
  action?: string;
}

export interface PatchOutcome {
  before: FlagConfigDto;
  after: FlagConfigDto;
  descriptions: string[];
  envVersion: number;
}

const resultSchema = z.object({
  targets: z.array(targetSchema),
  rules: z.array(ruleSchema).max(200),
  fallthrough: serveSchema,
});

@Injectable()
export class ChangesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WebhookDispatcher) private readonly webhooks: WebhookDispatcher,
  ) {}

  async runningExperiment(
    sql: Sql,
    flagId: string,
    envId: string,
  ): Promise<{ id: string; key: string } | null> {
    const row = await sql.maybe<{ id: string; key: string }>(
      "SELECT id, key FROM experiments WHERE flag_id = $1 AND env_id = $2 AND status = 'running'",
      [flagId, envId],
    );
    return row ?? null;
  }

  async lockConfig(sql: Sql, project: ProjectRef, flagKey: string, envKey: string) {
    const row = await sql.maybe<ConfigRow & { flag: FlagRow; env: EnvRow }>(
      `SELECT fc.*, row_to_json(f.*) AS flag, row_to_json(e.*) AS env
       FROM flag_configs fc
       JOIN flags f ON f.id = fc.flag_id
       JOIN environments e ON e.id = fc.env_id
       WHERE f.project_id = $1 AND f.key = $2 AND e.key = $3
       FOR UPDATE OF fc`,
      [project.id, flagKey, envKey],
    );
    if (!row) throw notFound(`flag ${flagKey} in ${envKey}`);
    return row;
  }

  async patchInTx(
    sql: Sql,
    input: PatchInput,
  ): Promise<{ outcome: PatchOutcome; post: () => Promise<void> }> {
    const row = await this.lockConfig(sql, input.project, input.flagKey, input.envKey);
    const flag = row.flag;
    const env = row.env;
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== null &&
      input.expectedVersion !== row.version
    ) {
      throw conflict('flag configuration was modified by someone else', {
        currentVersion: row.version,
        expectedVersion: input.expectedVersion,
      });
    }
    const experiment = await this.runningExperiment(sql, flag.id, env.id);
    const before = toConfig(row, flag.key, env.key, experiment);
    const nextState = applyInstructions(
      {
        on: before.on,
        offVariation: before.offVariation,
        targets: before.targets,
        rules: before.rules,
        fallthrough: before.fallthrough,
      },
      input.instructions,
      { variations: flag.variations },
    );
    const validated = resultSchema.safeParse(nextState);
    if (!validated.success) {
      throw unprocessable('resulting configuration is invalid', {
        issues: validated.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const updated = await sql.one<ConfigRow>(
      `UPDATE flag_configs SET "on" = $3, off_variation = $4, targets = $5, rules = $6, fallthrough = $7,
         version = version + 1, updated_at = now(), updated_by = $8
       WHERE flag_id = $1 AND env_id = $2 RETURNING *`,
      [
        flag.id,
        env.id,
        nextState.on,
        nextState.offVariation,
        JSON.stringify(nextState.targets),
        JSON.stringify(nextState.rules),
        JSON.stringify(nextState.fallthrough),
        input.actor?.id ?? null,
      ],
    );
    const envVersion = await bumpEnvVersion(sql, env.id);
    const after = toConfig(updated, flag.key, env.key, experiment);
    const descriptions = input.instructions.map((i) =>
      describeInstruction(i, { variations: flag.variations }),
    );
    await this.audit.record(sql, {
      orgId: input.project.orgId,
      projectId: input.project.id,
      envId: env.id,
      actor: input.actor,
      action: input.action ?? 'flag.config.updated',
      resource: `flag/${flag.key}/env/${env.key}`,
      before,
      after,
      instructions: input.instructions,
      descriptions,
      comment: input.comment ?? null,
    });
    await this.notifyFlag(sql, input.project, env, flag.key, after.version, envVersion, input.actor);
    const outcome: PatchOutcome = { before, after, descriptions, envVersion };
    const post = async () => {
      this.webhooks.emit({
        orgId: input.project.orgId,
        projectId: input.project.id,
        projectKey: input.project.key,
        envKey: env.key,
        event: 'flag.config.updated',
        text: `updated flag ${flag.key}: ${descriptions.join('; ')}`,
        actor: input.actor,
        data: {
          flagKey: flag.key,
          version: after.version,
          instructions: input.instructions,
          diff: jsonDiff(before, after),
        },
      });
    };
    return { outcome, post };
  }

  async patch(input: PatchInput): Promise<PatchOutcome> {
    const { outcome, post } = await this.db.tx((sql) => this.patchInTx(sql, input));
    await post();
    return outcome;
  }

  async notifyFlag(
    sql: Sql,
    project: ProjectRef,
    env: Pick<EnvRow, 'id' | 'key'>,
    flagKey: string,
    version: number,
    envVersion: number,
    actor: Actor | null,
  ): Promise<void> {
    await this.notify(sql, {
      type: 'flag.changed',
      envId: env.id,
      envKey: env.key,
      projectId: project.id,
      projectKey: project.key,
      flagKey,
      version,
      envVersion,
      actor,
      at: new Date().toISOString(),
    });
  }

  async notifySegment(
    sql: Sql,
    project: ProjectRef,
    env: Pick<EnvRow, 'id' | 'key'>,
    segmentKey: string,
    version: number,
    envVersion: number,
    actor: Actor | null,
  ): Promise<void> {
    await this.notify(sql, {
      type: 'segment.changed',
      envId: env.id,
      envKey: env.key,
      projectId: project.id,
      projectKey: project.key,
      segmentKey,
      version,
      envVersion,
      actor,
      at: new Date().toISOString(),
    });
  }

  async notifyEnv(
    sql: Sql,
    project: ProjectRef,
    env: Pick<EnvRow, 'id' | 'key'>,
    envVersion: number,
    actor: Actor | null,
  ): Promise<void> {
    await this.notify(sql, {
      type: 'env.changed',
      envId: env.id,
      envKey: env.key,
      projectId: project.id,
      projectKey: project.key,
      version: envVersion,
      envVersion,
      actor,
      at: new Date().toISOString(),
    });
  }

  private async notify(sql: Sql, notification: ChangeNotification): Promise<void> {
    await enqueueOutbox(sql, { topic: 'changes', payload: notification });
  }
}
