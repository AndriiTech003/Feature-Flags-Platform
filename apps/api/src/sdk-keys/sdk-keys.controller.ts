import { Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { createSdkKeySchema, rotateSdkKeySchema } from '@ashamrai/flags-contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { generateSdkKey } from '../common/crypto';
import { conflict, notFound } from '../common/errors';
import { actorOf } from '../common/http';
import { ZBody } from '../common/zod';
import type { Sql } from '../db/db';
import { iso } from '../db/db';
import { Database } from '../infra/database';
import { enqueueOutbox } from '../outbox/outbox';

interface KeyRow {
  id: string;
  env_id: string;
  kind: 'server' | 'client';
  name: string | null;
  prefix: string;
  expires_at: Date | null;
  created_at: Date;
}

function toKey(row: KeyRow) {
  const expiresAt = iso(row.expires_at);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    prefix: row.prefix,
    maskedKey: `${row.prefix}…`,
    expiresAt,
    active: !row.expires_at || new Date(row.expires_at).getTime() > Date.now(),
    createdAt: iso(row.created_at),
  };
}

export async function issueSdkKey(
  sql: Sql,
  envId: string,
  kind: 'server' | 'client',
  name: string | null,
  userId: string | null,
) {
  const generated = generateSdkKey(kind);
  const row = await sql.one<KeyRow>(
    'INSERT INTO sdk_keys (env_id, kind, name, key_hash, prefix, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [envId, kind, name, generated.hash, generated.prefix, userId],
  );
  return { ...toKey(row), key: generated.key };
}

@Controller('projects/:p/envs/:env/sdk-keys')
export class SdkKeysController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Param('p') p: string, @Param('env') envKey: string) {
    const project = await this.access.project(user, p);
    const env = await this.access.env(project, envKey);
    const rows = await this.db.query<KeyRow>(
      'SELECT * FROM sdk_keys WHERE env_id = $1 ORDER BY created_at DESC',
      [env.id],
    );
    return { items: rows.map(toKey) };
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('env') envKey: string,
    @ZBody(createSdkKeySchema) body: z.infer<typeof createSdkKeySchema>,
  ) {
    const project = await this.access.project(user, p, 'admin');
    const env = await this.access.env(project, envKey);
    return this.db.tx(async (sql) => {
      const key = await issueSdkKey(sql, env.id, body.kind, body.name ?? null, user.id);
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        envId: env.id,
        actor: actorOf(user),
        action: 'sdk_key.created',
        resource: `sdk-key/${key.prefix}`,
        after: { kind: key.kind, prefix: key.prefix },
      });
      return key;
    });
  }

  @Post(':id/rotate')
  async rotate(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('env') envKey: string,
    @Param('id') id: string,
    @ZBody(rotateSdkKeySchema) body: z.infer<typeof rotateSdkKeySchema>,
  ) {
    const project = await this.access.project(user, p, 'admin');
    const env = await this.access.env(project, envKey);
    const result = await this.db.tx(async (sql) => {
      const old = await sql.maybe<KeyRow>('SELECT * FROM sdk_keys WHERE id = $1 AND env_id = $2 FOR UPDATE', [
        id,
        env.id,
      ]);
      if (!old) throw notFound('sdk key');
      if (old.expires_at && new Date(old.expires_at).getTime() <= Date.now())
        throw conflict('key is already expired');
      const expiresAt = new Date(Date.now() + body.gracePeriodMinutes * 60000);
      const updated = await sql.one<KeyRow>('UPDATE sdk_keys SET expires_at = $2 WHERE id = $1 RETURNING *', [
        id,
        expiresAt,
      ]);
      const fresh = await issueSdkKey(sql, env.id, old.kind, old.name, user.id);
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        envId: env.id,
        actor: actorOf(user),
        action: 'sdk_key.rotated',
        resource: `sdk-key/${old.prefix}`,
        after: { newPrefix: fresh.prefix, oldExpiresAt: expiresAt.toISOString() },
        descriptions: [
          `rotated ${old.kind} key ${old.prefix}…, old key valid until ${expiresAt.toISOString()}`,
        ],
      });
      await enqueueOutbox(sql, { topic: 'sdk-keys', payload: { envId: env.id } });
      return { previous: toKey(updated), current: fresh };
    });
    return result;
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('env') envKey: string,
    @Param('id') id: string,
  ) {
    const project = await this.access.project(user, p, 'admin');
    const env = await this.access.env(project, envKey);
    await this.db.tx(async (sql) => {
      const deleted = await sql.query<KeyRow>(
        'DELETE FROM sdk_keys WHERE id = $1 AND env_id = $2 RETURNING *',
        [id, env.id],
      );
      if (deleted.length === 0) throw notFound('sdk key');
      await this.audit.record(sql, {
        orgId: project.orgId,
        projectId: project.id,
        envId: env.id,
        actor: actorOf(user),
        action: 'sdk_key.revoked',
        resource: `sdk-key/${deleted[0]!.prefix}`,
      });
      await enqueueOutbox(sql, { topic: 'sdk-keys', payload: { envId: env.id } });
    });
  }
}
