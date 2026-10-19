import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../modules/auth/jwt-auth.guard';
import type { Role } from '../auth.types';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from './roles.decorator';

export function RequireRoles(...roles: Role[]) {
  return applyDecorators(
    Roles(...roles),
    UseGuards(JwtAuthGuard, RolesGuard),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({
      description:
        'Missing/invalid access token, inactive user or expired/revoked session',
    }),
  );
}
