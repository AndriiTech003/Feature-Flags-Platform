import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { loginSchema, signupSchema } from '@ashamrai/flags-contracts';
import type { AppConfig } from '../config';
import { hashPassword, signJwt, verifyPassword } from '../common/crypto';
import { conflict, unauthorized } from '../common/errors';
import { Database } from '../infra/database';
import { APP_CONFIG } from '../tokens';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  github_id: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  issue(user: Pick<UserRow, 'id' | 'email' | 'name'>) {
    return {
      token: signJwt(
        { sub: user.id, email: user.email, name: user.name },
        this.config.jwtSecret,
        this.config.jwtTtlSeconds,
      ),
      expiresIn: this.config.jwtTtlSeconds,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  async signup(input: z.infer<typeof signupSchema>) {
    const existing = await this.db.maybe('SELECT id FROM users WHERE lower(email) = lower($1)', [
      input.email,
    ]);
    if (existing) throw conflict('email is already registered');
    const passwordHash = await hashPassword(input.password);
    const user = await this.db.tx(async (sql) => {
      const user = await sql.one<UserRow>(
        'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING *',
        [input.email, passwordHash, input.name],
      );
      const org = await sql.one<{ id: string }>('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [
        input.organizationName ?? `${input.name}'s organization`,
      ]);
      await sql.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')", [
        org.id,
        user.id,
      ]);
      return user;
    });
    return this.issue(user);
  }

  async login(input: z.infer<typeof loginSchema>) {
    const user = await this.db.maybe<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [
      input.email,
    ]);
    if (!user || !(await verifyPassword(input.password, user.password_hash)))
      throw unauthorized('invalid email or password');
    return this.issue(user);
  }

  async me(userId: string) {
    const user = await this.db.maybe<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user) throw unauthorized();
    const orgs = await this.db.query<{ id: string; name: string; role: string }>(
      `SELECT o.id, o.name, m.role FROM organizations o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = $1 ORDER BY o.created_at`,
      [userId],
    );
    return { id: user.id, email: user.email, name: user.name, organizations: orgs };
  }

  githubAuthorizeUrl(state: string): string | null {
    if (!this.config.github) return null;
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.config.github.clientId);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async githubCallback(code: string) {
    if (!this.config.github) throw unauthorized('GitHub OAuth is not configured');
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.github.clientId,
        client_secret: this.config.github.clientSecret,
        code,
      }),
    });
    const tokenBody = (await tokenResponse.json()) as { access_token?: string };
    if (!tokenBody.access_token) throw unauthorized('GitHub did not return an access token');
    const headers = {
      authorization: `Bearer ${tokenBody.access_token}`,
      accept: 'application/vnd.github+json',
    };
    const profile = (await (await fetch('https://api.github.com/user', { headers })).json()) as {
      id: number;
      login: string;
      name?: string;
      email?: string;
    };
    let email = profile.email;
    if (!email) {
      const emails = (await (
        await fetch('https://api.github.com/user/emails', { headers })
      ).json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      email =
        emails.find((e) => e.primary && e.verified)?.email ?? `${profile.login}@users.noreply.github.com`;
    }
    const githubId = String(profile.id);
    const existing = await this.db.maybe<UserRow>(
      'SELECT * FROM users WHERE github_id = $1 OR lower(email) = lower($2) LIMIT 1',
      [githubId, email],
    );
    if (existing) {
      if (!existing.github_id)
        await this.db.query('UPDATE users SET github_id = $2 WHERE id = $1', [existing.id, githubId]);
      return this.issue(existing);
    }
    const user = await this.db.tx(async (sql) => {
      const user = await sql.one<UserRow>(
        'INSERT INTO users (email, name, github_id) VALUES ($1, $2, $3) RETURNING *',
        [email, profile.name ?? profile.login, githubId],
      );
      const org = await sql.one<{ id: string }>('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [
        `${profile.login}'s organization`,
      ]);
      await sql.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')", [
        org.id,
        user.id,
      ]);
      return user;
    });
    return this.issue(user);
  }
}
