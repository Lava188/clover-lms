import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isRole, type AuthenticatedUser, type Role } from '../auth.types';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;
    // Missing metadata never makes this guard an authentication bypass.
    if (
      !user ||
      typeof user.id !== 'string' ||
      !user.id.trim() ||
      user.isActive !== true
    ) {
      throw new UnauthorizedException('Authentication is required.');
    }
    if (!isRole(user.role)) throw new ForbiddenException('Access denied.');
    const allowed = this.reflector.getAllAndOverride<readonly Role[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (
      allowed !== undefined &&
      (!allowed.length || !allowed.includes(user.role))
    ) {
      throw new ForbiddenException('Access denied.');
    }
    return true;
  }
}
