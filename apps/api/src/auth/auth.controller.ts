import { Controller, Get, HttpCode, Inject, Post, Query, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { loginSchema, signupSchema } from '@ashamrai/flags-contracts';
import type { z } from 'zod';
import type { AppConfig } from '../config';
import { CurrentUser, Public, type AuthUser } from '../common/auth';
import { notFound } from '../common/errors';
import { ZBody } from '../common/zod';
import { APP_CONFIG } from '../tokens';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('signup')
  signup(@ZBody(signupSchema) body: z.infer<typeof signupSchema>) {
    return this.auth.signup(body);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@ZBody(loginSchema) body: z.infer<typeof loginSchema>) {
    return this.auth.login(body);
  }

  @Post('logout')
  @HttpCode(204)
  logout() {
    return undefined;
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@CurrentUser() user: AuthUser) {
    return this.auth.issue(user);
  }

  @Public()
  @Get('github')
  github(@Res() res: Response) {
    const state = randomBytes(16).toString('hex');
    const url = this.auth.githubAuthorizeUrl(state);
    if (!url) throw notFound('GitHub OAuth');
    res.cookie?.('ffp_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 600000 });
    res.redirect(url);
  }

  @Public()
  @Get('github/callback')
  async githubCallback(@Query('code') code: string, @Res() res: Response) {
    const session = await this.auth.githubCallback(code);
    res.redirect(`${this.config.dashboardUrl}/login#token=${encodeURIComponent(session.token)}`);
  }
}
