import { Controller, Get, Inject, Param } from '@nestjs/common';
import { auditQuerySchema } from '@ashamrai/flags-contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { ZQuery } from '../common/zod';
import { AuditService } from './audit.service';

@Controller()
export class AuditController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('projects/:p/audit-log')
  async list(
    @CurrentUser() user: AuthUser,
    @Param('p') p: string,
    @ZQuery(auditQuerySchema) query: z.infer<typeof auditQuerySchema>,
  ) {
    const project = await this.access.project(user, p);
    const items = await this.audit.list(project.id, query);
    return { items, nextCursor: items.length === query.limit ? String(items[items.length - 1]!.id) : null };
  }
}
