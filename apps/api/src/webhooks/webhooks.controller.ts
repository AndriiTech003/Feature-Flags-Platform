import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { createWebhookSchema, updateWebhookSchema } from '@ashamrai/flags-contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { badRequest, notFound } from '../common/errors';
import { actorOf } from '../common/http';
import { ZBody } from '../common/zod';
import { iso } from '../db/db';
import { Database } from '../infra/database';
import { WebhookDispatcher } from './dispatcher';

interface HookRow {
  id: string;
  org_id: string;
  project_id: string | null;
  project_key: string | null;
  url: string;
  secret: string | null;
  events: string[];
  enabled: boolean;
  created_at: Date;
}

function toHook(row: HookRow) {
  return {
    id: row.id,
    organizationId: row.org_id,
    projectKey: row.project_key,
    url: row.url,
    hasSecret: !!row.secret,
    events: row.events,
    enabled: row.enabled,
    createdAt: iso(row.created_at),
  };
}

const SELECT = 'SELECT w.*, p.key AS project_key FROM webhooks w LEFT JOIN projects p ON p.id = w.project_id';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WebhookDispatcher) private readonly dispatcher: WebhookDispatcher,
  ) {}

  private async defaultOrg(user: AuthUser, orgId?: string): Promise<string> {
    if (orgId) return orgId;
    const row = await this.db.maybe<{ org_id: string }>(
      'SELECT org_id FROM org_members WHERE user_id = $1 ORDER BY created_at LIMIT 1',
      [user.id],
    );
    if (!row) throw badRequest('no organization');
    return row.org_id;
  }

  private async hook(user: AuthUser, id: string, min: 'reader' | 'admin') {
    const row = await this.db.maybe<HookRow>(`${SELECT} WHERE w.id = $1`, [id]);
    if (!row) throw notFound('webhook');
    await this.access.orgRole(user, row.org_id, min);
    return row;
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('orgId') orgId?: string) {
    const org = await this.defaultOrg(user, orgId);
    await this.access.orgRole(user, org);
    return {
      items: (await this.db.query<HookRow>(`${SELECT} WHERE w.org_id = $1 ORDER BY w.created_at`, [org])).map(
        toHook,
      ),
    };
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @ZBody(createWebhookSchema) body: z.infer<typeof createWebhookSchema>,
    @Query('orgId') orgId?: string,
  ) {
    const org = await this.defaultOrg(user, orgId);
    await this.access.orgRole(user, org, 'admin');
    let projectId: string | null = null;
    if (body.projectKey) projectId = (await this.access.project(user, body.projectKey, 'admin')).id;
    const row = await this.db.one<{ id: string }>(
      'INSERT INTO webhooks (org_id, project_id, url, secret, events, enabled) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [org, projectId, body.url, body.secret ?? null, body.events, body.enabled],
    );
    await this.audit.record(this.db, {
      orgId: org,
      projectId,
      actor: actorOf(user),
      action: 'webhook.created',
      resource: `webhook/${row.id}`,
      after: { url: body.url, events: body.events },
    });
    return toHook(await this.db.one<HookRow>(`${SELECT} WHERE w.id = $1`, [row.id]));
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @ZBody(updateWebhookSchema) body: z.infer<typeof updateWebhookSchema>,
  ) {
    const hook = await this.hook(user, id, 'admin');
    await this.db.query(
      'UPDATE webhooks SET url = $2, secret = $3, events = $4, enabled = $5 WHERE id = $1',
      [
        id,
        body.url ?? hook.url,
        body.secret ?? hook.secret,
        body.events ?? hook.events,
        body.enabled ?? hook.enabled,
      ],
    );
    await this.audit.record(this.db, {
      orgId: hook.org_id,
      projectId: hook.project_id,
      actor: actorOf(user),
      action: 'webhook.updated',
      resource: `webhook/${id}`,
    });
    return toHook(await this.db.one<HookRow>(`${SELECT} WHERE w.id = $1`, [id]));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const hook = await this.hook(user, id, 'admin');
    await this.db.query('DELETE FROM webhooks WHERE id = $1', [id]);
    await this.audit.record(this.db, {
      orgId: hook.org_id,
      projectId: hook.project_id,
      actor: actorOf(user),
      action: 'webhook.deleted',
      resource: `webhook/${id}`,
    });
  }

  @Post(':id/test')
  async test(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const hook = await this.hook(user, id, 'admin');
    const body = JSON.stringify(
      this.dispatcher.payload({
        orgId: hook.org_id,
        projectId: hook.project_id,
        event: 'webhook.test',
        text: 'sent a test notification',
        actor: actorOf(user),
        data: {},
      }),
    );
    const ok = await this.dispatcher.deliver(hook, 'webhook.test', body, 1);
    return { ok };
  }

  @Get(':id/deliveries')
  async deliveries(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.hook(user, id, 'reader');
    const rows = await this.db.query<Record<string, unknown>>(
      'SELECT id, event, status_code, ok, attempt, error, duration_ms, created_at FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY id DESC LIMIT 50',
      [id],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        event: r.event,
        statusCode: r.status_code,
        ok: r.ok,
        attempt: r.attempt,
        error: r.error,
        durationMs: r.duration_ms,
        createdAt: iso(r.created_at),
      })),
    };
  }
}
