import {
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_CONFIG } from '../tokens';
import type { AppConfig } from '../config';
import { verifyJwt } from './crypto';
import { unauthorized } from './errors';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export type AuthedRequest = Request & { user?: AuthUser };

const PUBLIC_KEY = 'ffp:public';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const request = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!request.user) throw unauthorized();
  return request.user;
});

export function tokenFrom(request: Request): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const query = request.query.access_token;
  return typeof query === 'string' ? query : null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = tokenFrom(request);
    if (token) {
      const claims = verifyJwt(token, this.config.jwtSecret);
      if (claims) request.user = { id: claims.sub, email: claims.email, name: claims.name };
    }
    if (isPublic) return true;
    if (!request.user) throw unauthorized();
    return true;
  }
}
