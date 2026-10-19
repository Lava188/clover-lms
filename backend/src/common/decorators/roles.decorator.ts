import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension, ApiForbiddenResponse } from '@nestjs/swagger';
import { isRole, type Role } from '../auth.types';

export const ROLES_KEY = Symbol('clover:roles');

// Metadata only. Use RequireRoles to also activate authentication/authorization.
export function Roles(...roles: Role[]) {
  if (!roles.length || !roles.every(isRole)) {
    throw new Error('Roles requires at least one valid application role.');
  }
  return applyDecorators(
    SetMetadata(ROLES_KEY, Object.freeze([...new Set(roles)])),
    ApiExtension('x-required-roles', roles),
    ApiForbiddenResponse({
      description: `Required role: ${roles.join(' or ')}. Resource-level access checks may also apply.`,
    }),
  );
}
