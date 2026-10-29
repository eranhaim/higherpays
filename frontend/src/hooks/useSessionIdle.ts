import { useEffect } from 'react';
import { apiBaseUrl } from '../api/http';
import { queryClient } from '../lib/queryClient';
import { startSessionIdleMonitor } from '../lib/sessionIdle';
import { useAuthStore, useIsAuthenticated } from '../store/auth';
import { useSessionStore } from '../store/session';

export function useSessionIdle(): void {
  const authenticated = useIsAuthenticated();

  useEffect(() => {
    if (!authenticated) return;
    return startSessionIdleMonitor(() => {
      // The refresh cookie identifies the session even after a page reload.
      // Keep the request alive during navigation, without refreshing tokens.
      void fetch(`${apiBaseUrl}/auth/logout`, {
        method: 'POST', credentials: 'include', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      }).catch(() => {});
      useAuthStore.getState().clear();
      useSessionStore.getState().clear();
      queryClient.clear();
      window.location.assign('/login');
    });
  }, [authenticated]);
}
