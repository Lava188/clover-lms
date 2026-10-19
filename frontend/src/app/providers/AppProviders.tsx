import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { useEffect } from 'react';
import { auth } from '@/features/auth/auth';
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 10000 } },
});
export function AppProviders({ children }: PropsWithChildren) {
  useEffect(() => {
    const identity = () => {
      const state = auth.getState();
      return state.user ? `${state.user.id}:${state.user.role}` : null;
    };
    let previous = identity();
    const unsubscribe = auth.subscribe(() => {
      const next = identity();
      if (next !== previous) {
        void queryClient.cancelQueries();
        queryClient.clear();
        previous = next;
      }
    });
    void auth.restoreSession();
    return unsubscribe;
  }, []);
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
