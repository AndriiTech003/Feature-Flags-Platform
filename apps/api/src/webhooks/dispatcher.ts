import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '../config';
import { hmacSignature } from '../common/crypto';
import { Database } from '../infra/database';
import { APP_CONFIG } from '../tokens';

export interface WebhookEvent {
  orgId: string;
  projectId: string | null;
  projectKey?: string;
  envKey?: string;
  event: string;
  text: string;
  actor?: { id: string; name: string } | null;
  data: Record<string, unknown>;
}

interface WebhookRow {
  id: string;
  url: string;
  secret: string | null;
  events: string[];
  project_id: string | null;
}

@Injectable()
export class WebhookDispatcher implements OnModuleDestroy {
  private readonly inflight = new Set<Promise<void>>();
  private closed = false;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  emit(event: WebhookEvent): void {
    if (this.closed) return;
    const task = this.deliverAll(event).catch(() => undefined);
    this.inflight.add(task);
    void task.finally(() => this.inflight.delete(task));
  }

  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  payload(event: WebhookEvent): Record<string, unknown> {
    const where = [event.projectKey, event.envKey].filter(Boolean).join(' / ');
    return {
      text: `${event.actor?.name ?? 'System'} ${event.text}${where ? ` (${where})` : ''}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${event.event}* · ${where || 'organization'}` } },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `${event.actor?.name ?? 'System'}: ${event.text}` }],
        },
      ],
      event: event.event,
      project: event.projectKey ?? null,
      environment: event.envKey ?? null,
      actor: event.actor ?? null,
      data: event.data,
      sentAt: new Date().toISOString(),
    };
  }

  private async deliverAll(event: WebhookEvent): Promise<void> {
    const hooks = await this.db.query<WebhookRow>(
      `SELECT id, url, secret, events, project_id FROM webhooks
       WHERE org_id = $1 AND enabled AND (project_id IS NULL OR project_id = $2)
         AND ($3 = ANY(events) OR '*' = ANY(events))`,
      [event.orgId, event.projectId, event.event],
    );
    const body = JSON.stringify(this.payload(event));
    await Promise.all(hooks.map((hook) => this.deliver(hook, event.event, body)));
  }

  async deliver(hook: WebhookRow, eventName: string, body: string, maxAttempts = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      let statusCode: number | null = null;
      let error: string | null = null;
      try {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'user-agent': 'ffp-webhooks/1.0',
          'x-ffp-event': eventName,
        };
        if (hook.secret) headers['x-ffp-signature'] = hmacSignature(hook.secret, body);
        const response = await fetch(hook.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.config.webhookTimeoutMs),
        });
        statusCode = response.status;
        await response.arrayBuffer().catch(() => undefined);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
      if (this.closed) return ok;
      await this.db
        .query(
          `INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, ok, attempt, error, duration_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [hook.id, eventName, body, statusCode, ok, attempt, error, Date.now() - started],
        )
        .catch(() => undefined);
      if (ok) return true;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 200 * 4 ** (attempt - 1)));
    }
    return false;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.race([this.idle(), new Promise((r) => setTimeout(r, 2000))]);
    this.closed = true;
  }
}
