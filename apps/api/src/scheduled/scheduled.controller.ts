import { Controller, Delete, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { createScheduledChangeSchema, type Instruction } from '@ashamrai/flags-contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { actorOf } from '../common/http';
import { ZBody } from '../common/zod';
import { ScheduledService } from './scheduled.service';

@Controller()
export class ScheduledController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ScheduledService) private readonly service: ScheduledService,
  ) {}

  @Post('projects/:p/flags/:key/envs/:env/schedule')
  async create(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('key') key: string,
    @Param('env') env: string,
    @ZBody(createScheduledChangeSchema) body: z.infer<typeof createScheduledChangeSchema>,
  ) {
    const project = await this.access.project(user, p, 'writer');
    return this.service.create(
      project,
      key,
      env,
      body.instructions as Instruction[],
      body.executeAt,
      body.comment,
      actorOf(user),
    );
  }

  @Get('projects/:p/scheduled-changes')
  async list(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Query('status') status: string | undefined,
  ) {
    return { items: await this.service.list(await this.access.project(user, p), status) };
  }

  @Delete('scheduled-changes/:id')
  async cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.cancel(user, id);
  }
}
