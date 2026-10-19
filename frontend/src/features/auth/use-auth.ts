import { useSyncExternalStore } from 'react';
import { auth } from './auth';
import { canUseAdminCms, canUseStudentWebsite } from './auth.types';

export function useAuth() {
  const state = useSyncExternalStore(auth.subscribe, auth.getState);
  return {
    ...state,
    login: auth.login,
    logout: auth.logout,
    refreshSession: auth.refreshSession,
    restoreSession: auth.restoreSession,
    getCurrentUser: auth.getCurrentUser,
    canUseStudentWebsite: canUseStudentWebsite(state.user),
    canUseAdminCms: canUseAdminCms(state.user),
  };
}
