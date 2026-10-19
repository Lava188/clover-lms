export const USER_ROLES = {
  ADMIN: 'ADMIN',
  TEACHER: 'TEACHER',
  STUDENT: 'STUDENT',
} as const;

export type Role = (typeof USER_ROLES)[keyof typeof USER_ROLES];
export const ROLE_VALUES: readonly Role[] = Object.freeze(
  Object.values(USER_ROLES),
);
export function isRole(value: unknown): value is Role {
  return ROLE_VALUES.some((role) => role === value);
}

// These are route-level permissions, not ownership or resource assignments.
export const ROLE_POLICIES = Object.freeze({
  ADMIN_ONLY: Object.freeze([USER_ROLES.ADMIN]),
  CMS: Object.freeze([USER_ROLES.ADMIN, USER_ROLES.TEACHER]),
  STUDENT_ONLY: Object.freeze([USER_ROLES.STUDENT]),
});

export interface AuthenticatedUser {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  isActive: boolean;
}
