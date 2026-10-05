import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import type { AppConfig } from './config';
import { Database } from './infra/database';
import { migrate } from './db/migrate';
import { OutboxService } from './outbox/outbox.service';
import { ScheduledService } from './scheduled/scheduled.service';

export interface RunningApi {
  app: NestExpressApplication;
  url: string;
  close(): Promise<void>;
}

export async function createApp(
  config: AppConfig,
  options: { listen?: boolean; migrate?: boolean } = {},
): Promise<RunningApi> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    logger: config.logRequests ? ['log', 'warn', 'error'] : ['warn', 'error'],
    bodyParser: true,
  });
  app.enableCors({ origin: true, credentials: true, exposedHeaders: ['ETag'] });
  app.useBodyParser('json', { limit: '5mb' });
  app.enableShutdownHooks();
  if (options.migrate !== false) await migrate(app.get(Database));
  if (config.workerEnabled) app.get(ScheduledService).start(config.workerIntervalMs);
  if (config.outboxPublisher) await app.get(OutboxService).start();
  let url = '';
  if (options.listen !== false) {
    await app.listen(config.port, config.host);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    url = `http://${config.host}:${port}`;
  }
  return {
    app,
    url,
    close: async () => {
      await app.close();
    },
  };
}
