import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '../config';
import { Database } from '../infra/database';
import { Notifier } from '../infra/notifier';
import { APP_CONFIG } from '../tokens';
import { OutboxPublisher } from './outbox';

@Injectable()
export class OutboxService implements OnModuleDestroy {
  readonly publisher: OutboxPublisher;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(Database) db: Database,
    @Inject(Notifier) notifier: Notifier,
  ) {
    this.publisher = new OutboxPublisher({
      db,
      listenUrl: config.databaseUrl,
      publish: (topic, payload) => notifier.publish(topic, payload),
      pollIntervalMs: config.outboxPollMs,
    });
  }

  start(): Promise<void> {
    return this.publisher.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.publisher.stop();
  }
}
