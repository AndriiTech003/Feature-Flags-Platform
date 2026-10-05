import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '../config';
import { Db } from '../db/db';
import { APP_CONFIG } from '../tokens';

@Injectable()
export class Database extends Db implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super(config.databaseUrl, 10);
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
