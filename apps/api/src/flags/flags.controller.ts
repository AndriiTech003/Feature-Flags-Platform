import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  copyConfigSchema,
  createFlagSchema,
  patchRequestSchema,
  updateFlagSchema,
  type Instruction,
} from '@ashamrai/flags-contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { ApiError } from '../common/errors';
import { actorOf, parseIfMatch } from '../common/http';
import { parseOrThrow, ZBody } from '../common/zod';
import { ChangeRequestsService } from '../change-requests/change-requests.service';
import { ChangesService } from './changes.service';
import { FlagsService, type FlagListFilters } from './flags.service';

@Controller()
export class FlagsController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(FlagsService) private readonly flags: FlagsService,
    @Inject(ChangesService) private readonly changes: ChangesService,
    @Inject(ChangeRequestsService) private readonly changeRequests: ChangeRequestsService,
  ) {}

  @Get('projects/:p/flags')
  async list(@CurrentUser() user: AuthUser, @Param('p') p: string, @Query() query: FlagListFilters) {
    const project = await this.access.project(user, p);
    return { items: await this.flags.list(project, query) };
  }

  @Post('projects/:p/flags')
  async create(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @ZBody(createFlagSchema) body: z.infer<typeof createFlagSchema>,
  ) {
    const project = await this.access.project(user, p, 'writer');
    return this.flags.create(project, body, actorOf(user));
  }

  @Get('projects/:p/flags/:key')
  async get(@CurrentUser() user: AuthUser, @Param('p') p: string, @Param('key') key: string) {
    return this.flags.get(await this.access.project(user, p), key);
  }

  @Patch('projects/:p/flags/:key')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('key') key: string,
    @ZBody(updateFlagSchema) body: z.infer<typeof updateFlagSchema>,
  ) {
    return this.flags.update(await this.access.project(user, p, 'writer'), key, body, actorOf(user));
  }

  @Delete('projects/:p/flags/:key')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('p') p: string, @Param('key') key: string) {
    await this.flags.remove(await this.access.project(user, p, 'admin'), key, actorOf(user));
  }

  @Get('projects/:p/flags/:key/envs/:env')
  async config(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('key') key: string,
    @Param('env') env: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const config = await this.flags.getConfig(await this.access.project(user, p), key, env);
    res.setHeader('ETag', `"${config.version}"`);
    return config;
  }

  @Patch('projects/:p/flags/:key/envs/:env')
  async patch(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('key') key: string,
    @Param('env') envKey: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const project = await this.access.project(user, p, 'writer');
    const env = await this.access.env(project, envKey);
    const request = parseOrThrow(patchRequestSchema, Array.isArray(body) ? { instructions: body } : body);
    if (env.require_approval) {
      throw new ApiError(
        403,
        'approval_required',
        `environment ${env.key} requires an approved change request`,
        {
          changeRequestUrl: `/projects/${project.key}/flags/${key}/envs/${env.key}/change-requests`,
        },
      );
    }
    const outcome = await this.changes.patch({
      project,
      flagKey: key,
      envKey,
      instructions: request.instructions as Instruction[],
      actor: actorOf(user),
      expectedVersion: parseIfMatch(ifMatch),
      comment: request.comment ?? null,
    });
    res.setHeader('ETag', `"${outcome.after.version}"`);
    return { ...outcome.after, descriptions: outcome.descriptions };
  }

  @Post('projects/:p/flags/:key/copy')
  async copy(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Param('key') key: string,
    @ZBody(copyConfigSchema) body: z.infer<typeof copyConfigSchema>,
  ) {
    const project = await this.access.project(user, p, body.dryRun ? 'reader' : 'writer');
    const preview = await this.flags.copyPreview(project, key, body.source, body.target, body.includeTargets);
    if (body.dryRun || preview.instructions.length === 0) return { applied: false, ...preview };
    const target = await this.access.env(project, body.target);
    const comment = body.comment ?? `copied from ${body.source}`;
    if (target.require_approval) {
      const changeRequest = await this.changeRequests.create(
        project,
        key,
        body.target,
        preview.instructions,
        comment,
        actorOf(user),
      );
      return { applied: false, changeRequest, ...preview };
    }
    const outcome = await this.changes.patch({
      project,
      flagKey: key,
      envKey: body.target,
      instructions: preview.instructions,
      actor: actorOf(user),
      comment,
      action: 'flag.config.copied',
    });
    return { applied: true, ...preview, result: outcome.after, descriptions: outcome.descriptions };
  }

  @Get('projects/:p/compare')
  async compare(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Query('envs') envs: string | undefined,
  ) {
    return this.flags.compare(
      await this.access.project(user, p),
      envs ? envs.split(',').filter(Boolean) : [],
    );
  }

  @Get('projects/:p/envs/:env/ruleset')
  async ruleset(@CurrentUser() user: AuthUser, @Param('p') p: string, @Param('env') env: string) {
    return this.flags.ruleset(await this.access.project(user, p), env);
  }

  @Get('projects/:p/context-attributes')
  async attributes(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @Query('env') env: string | undefined,
  ) {
    const rows = await this.flags.contextAttributes(await this.access.project(user, p), env);
    return { items: rows.map((r) => ({ kind: r.kind, name: r.name, lastSeenAt: r.last_seen_at })) };
  }
}
