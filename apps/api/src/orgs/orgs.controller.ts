import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { createOrganizationSchema, inviteMemberSchema, updateMemberSchema } from '@ashamrai/flags-contracts';
import type { z } from 'zod';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, type AuthUser } from '../common/auth';
import { hashPassword, randomPassword } from '../common/crypto';
import { badRequest, conflict, notFound } from '../common/errors';
import { actorOf } from '../common/http';
import { ZBody } from '../common/zod';
import { iso } from '../db/db';
import { Database } from '../infra/database';

@Controller('orgs')
export class OrgsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const items = await this.db.query(
      `SELECT o.id, o.name, m.role FROM organizations o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = $1 ORDER BY o.created_at`,
      [user.id],
    );
    return { items };
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @ZBody(createOrganizationSchema) body: z.infer<typeof createOrganizationSchema>,
  ) {
    return this.db.tx(async (sql) => {
      const org = await sql.one<{ id: string; name: string }>(
        'INSERT INTO organizations (name) VALUES ($1) RETURNING id, name',
        [body.name],
      );
      await sql.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')", [
        org.id,
        user.id,
      ]);
      return { ...org, role: 'admin' };
    });
  }

  @Get(':org/members')
  async members(@CurrentUser() user: AuthUser, @Param('org') org: string) {
    await this.access.orgRole(user, org);
    const rows = await this.db.query<{
      id: string;
      email: string;
      name: string;
      role: string;
      created_at: Date;
    }>(
      `SELECT u.id, u.email, u.name, m.role, m.created_at FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at`,
      [org],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        joinedAt: iso(r.created_at),
      })),
    };
  }

  @Post(':org/members')
  async invite(
    @CurrentUser() user: AuthUser,
    @Param('org') org: string,
    @ZBody(inviteMemberSchema) body: z.infer<typeof inviteMemberSchema>,
  ) {
    await this.access.orgRole(user, org, 'admin');
    let temporaryPassword: string | null = null;
    const result = await this.db.tx(async (sql) => {
      let member = await sql.maybe<{ id: string; email: string; name: string }>(
        'SELECT id, email, name FROM users WHERE lower(email) = lower($1)',
        [body.email],
      );
      if (!member) {
        temporaryPassword = randomPassword();
        member = await sql.one<{ id: string; email: string; name: string }>(
          'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name',
          [body.email, body.name ?? body.email.split('@')[0], await hashPassword(temporaryPassword)],
        );
      }
      const found = member;
      const exists = await sql.maybe('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [
        org,
        found.id,
      ]);
      if (exists) throw conflict('user is already a member');
      await sql.query('INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)', [
        org,
        found.id,
        body.role,
      ]);
      await this.audit.record(sql, {
        orgId: org,
        actor: actorOf(user),
        action: 'member.added',
        resource: `member/${found.email}`,
        after: { role: body.role },
      });
      return found;
    });
    return { ...result, role: body.role, temporaryPassword };
  }

  @Patch(':org/members/:userId')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('org') org: string,
    @Param('userId') userId: string,
    @ZBody(updateMemberSchema) body: z.infer<typeof updateMemberSchema>,
  ) {
    await this.access.orgRole(user, org, 'admin');
    if (userId === user.id && body.role !== 'admin') throw badRequest('you cannot demote yourself');
    const rows = await this.db.query(
      'UPDATE org_members SET role = $3 WHERE org_id = $1 AND user_id = $2 RETURNING user_id',
      [org, userId, body.role],
    );
    if (rows.length === 0) throw notFound('member');
    await this.audit.record(this.db, {
      orgId: org,
      actor: actorOf(user),
      action: 'member.role_changed',
      resource: `member/${userId}`,
      after: { role: body.role },
    });
    return { id: userId, role: body.role };
  }

  @Delete(':org/members/:userId')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('org') org: string, @Param('userId') userId: string) {
    await this.access.orgRole(user, org, 'admin');
    if (userId === user.id) throw badRequest('you cannot remove yourself');
    await this.db.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [org, userId]);
    await this.audit.record(this.db, {
      orgId: org,
      actor: actorOf(user),
      action: 'member.removed',
      resource: `member/${userId}`,
    });
  }
}
