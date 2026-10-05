import { Controller, Get, Header, Inject } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Public } from '../common/auth';
import type { AppConfig } from '../config';
import { Database } from '../infra/database';
import { OutboxService } from '../outbox/outbox.service';
import { APP_CONFIG } from '../tokens';
import { buildOpenApi, SWAGGER_HTML, type RegisteredRoute } from './openapi';

export function listRoutes(instance: unknown): RegisteredRoute[] {
  const app = instance as { router?: { stack?: unknown[] }; _router?: { stack?: unknown[] } };
  const stack = (app.router?.stack ?? app._router?.stack ?? []) as Array<{
    route?: { path: string; methods: Record<string, boolean> };
  }>;
  const out: RegisteredRoute[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled && method !== '_all') out.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return out;
}

@Controller()
export class SystemController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('health')
  async health() {
    const started = Date.now();
    await this.db.query('SELECT 1');
    const latencyMs = Date.now() - started;
    const { published, failures, listening, lastError } = this.outbox.publisher.metrics;
    return {
      status: 'ok',
      db: { latencyMs },
      outbox: {
        publisher: this.config.outboxPublisher,
        listening,
        published,
        failures,
        lastError,
        pending: await this.outbox.publisher.pending(),
      },
    };
  }

  @Public()
  @Get('openapi.json')
  openapi() {
    return buildOpenApi(listRoutes(this.adapter.httpAdapter.getInstance()));
  }

  @Public()
  @Get('docs')
  @Header('Content-Type', 'text/html; charset=utf-8')
  docs() {
    return SWAGGER_HTML;
  }
}
