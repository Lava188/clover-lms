import { z } from 'zod';
// Pure shared role definitions: no NestJS/runtime server dependency is imported.
import {
  ROLE_VALUES,
  ROLE_POLICIES,
  type Role,
  type AuthenticatedUser,
} from '../../../../backend/src/common/auth.types';

export type UserRole = Role;
export type AuthUser = AuthenticatedUser;
export interface LoginRequest {
  email: string;
  password: string;
}
export interface LoginResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: AuthUser;
}
export type RefreshResponse = LoginResponse;
export interface ApiErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string;
}
export type AuthenticationState =
  | { status: 'initializing' | 'unauthenticated'; user: null }
  | { status: 'authenticated'; user: AuthUser };

export const authUserSchema = z.object({
  id: z.string().min(1),
  fullName: z.string(),
  email: z.email(),
  role: z.enum(ROLE_VALUES),
  isActive: z.boolean(),
});
export const loginResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  user: authUserSchema,
});
export const loginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(1024),
});
export { ROLE_POLICIES };
export function hasRole(
  user: AuthUser | null,
  roles: readonly UserRole[],
): boolean {
  return !!user?.isActive && roles.includes(user.role);
}
export const canUseStudentWebsite = (user: AuthUser | null) =>
  hasRole(user, ROLE_POLICIES.STUDENT_ONLY);
export const canUseAdminCms = (user: AuthUser | null) =>
  hasRole(user, ROLE_POLICIES.CMS);

export class AuthError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}
