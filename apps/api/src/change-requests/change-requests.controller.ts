import { Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import {
  createChangeRequestSchema,
  reviewChangeRequestSchema,
  type Instruction,
} from '@ashamrai/flags-contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { actorOf } from '../common/http';
import { ZBody } from '../common/zod';
import { ChangeRequestsService } from './change-requests.service';

@Controller()
export class ChangeRequestsController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ChangeRequestsService) private readonly service: ChangeRequestsService,
  ) {}

  @Post('projects/:p/flags/:key/envs/:env/change-requests')
  async create(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('key') key: string,
    @Param('env') env: string,
    @ZBody(createChangeRequestSchema) body: z.infer<typeof createChangeRequestSchema>,
  ) {
    const project = await this.access.project(user, p, 'writer');
    return this.service.create(
      project,
      key,
      env,
      body.instructions as Instruction[],
      body.comment,
      actorOf(user),
    );
  }

  @Get('projects/:p/change-requests')
  async list(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Query('status') status: string | undefined,
  ) {
    return { items: await this.service.list(await this.access.project(user, p), status) };
  }

  @Get('change-requests/:id')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.detail(user, id);
  }

  @Post('change-requests/:id/approve')
  async approve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @ZBody(reviewChangeRequestSchema) body: z.infer<typeof reviewChangeRequestSchema>,
  ) {
    return this.service.review(user, id, 'approved', body.comment);
  }

  @Post('change-requests/:id/reject')
  async reject(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @ZBody(reviewChangeRequestSchema) body: z.infer<typeof reviewChangeRequestSchema>,
  ) {
    return this.service.review(user, id, 'rejected', body.comment);
  }

  @Post('change-requests/:id/apply')
  async apply(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.apply(user, id);
  }
}
