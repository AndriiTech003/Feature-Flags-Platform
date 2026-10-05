import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AccessService } from './access/access.service';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { ChangeRequestsController } from './change-requests/change-requests.controller';
import { ChangeRequestsService } from './change-requests/change-requests.service';
import { AuthGuard } from './common/auth';
import { ErrorFilter } from './common/filter';
import type { AppConfig } from './config';
import { ExperimentsController } from './experiments/experiments.controller';
import { ResultsService } from './experiments/results.service';
import { ChangesService } from './flags/changes.service';
import { FlagsController } from './flags/flags.controller';
import { FlagsService } from './flags/flags.service';
import { Database } from './infra/database';
import { Notifier } from './infra/notifier';
import { InsightsController } from './insights/insights.controller';
import { SystemController } from './openapi/system.controller';
import { OrgsController } from './orgs/orgs.controller';
import { OutboxService } from './outbox/outbox.service';
import { ProjectsController } from './projects/projects.controller';
import { RealtimeController } from './realtime/realtime.controller';
import { ScheduledController } from './scheduled/scheduled.controller';
import { ScheduledService } from './scheduled/scheduled.service';
import { SdkKeysController } from './sdk-keys/sdk-keys.controller';
import { SegmentsController } from './segments/segments.controller';
import { APP_CONFIG } from './tokens';
import { WebhookDispatcher } from './webhooks/dispatcher';
import { WebhooksController } from './webhooks/webhooks.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        SystemController,
        AuthController,
        OrgsController,
        ProjectsController,
        FlagsController,
        SegmentsController,
        SdkKeysController,
        AuditController,
        ChangeRequestsController,
        ScheduledController,
        InsightsController,
        ExperimentsController,
        WebhooksController,
        RealtimeController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
        Database,
        Notifier,
        OutboxService,
        AccessService,
        AuditService,
        WebhookDispatcher,
        ChangesService,
        FlagsService,
        ChangeRequestsService,
        ScheduledService,
        ResultsService,
        AuthService,
      ],
    };
  }
}
