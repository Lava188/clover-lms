import { api } from '@/lib/api';
import { createAuthClient } from './auth-client';
import { ROLE_POLICIES } from './auth.types';

export const auth = createAuthClient(api, {
  apiBaseUrl: api.defaults.baseURL!,
  pageOrigin: window.location.origin,
  allowedRoles: ROLE_POLICIES.STUDENT_ONLY,
});
