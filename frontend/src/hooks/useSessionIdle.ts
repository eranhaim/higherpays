import { useEffect } from 'react';
import { apiBaseUrl } from '../api/http';
import { authApi } from '../api/endpoints/auth';
import { queryClient } from '../lib/queryClient';
import { startSessionIdleMonitor } from '../lib/sessionIdle';
import { useAuthStore, useIsAuthenticated } from '../store/auth';
import { useSessionStore } from '../store/session';

const ACTIVITY_SYNC_MS = 30_000;

export function useSessionIdle(): void {
  const authenticated = useIsAuthenticated();

  useEffect(() => {
    if (!authenticated) return;
    let lastSync = 0;
    let syncTimer: number | undefined;
    let pending = false;
    let ending = false;

    const syncActivity = () => {
      if (!pending || ending) return;
      pending = false;
      lastSync = Date.now();
      void authApi.activity().catch(() => {});
    };
    const onActivity = () => {
      pending = true;
      const wait = Math.max(0, lastSync + ACTIVITY_SYNC_MS - Date.now());
      if (wait === 0) {
        window.clearTimeout(syncTimer);
        syncTimer = undefined;
        syncActivity();
      } else if (syncTimer === undefined) {
        syncTimer = window.setTimeout(() => { syncTimer = undefined; syncActivity(); }, wait);
      }
    };
    const onPageHide = () => {
      if (!pending || ending) return;
      pending = false;
      const token = useAuthStore.getState().accessToken;
      if (!token) return;
      void fetch(`${apiBaseUrl}/auth/activity`, {
        method: 'POST', credentials: 'include', keepalive: true,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
      }).catch(() => {});
    };
    window.addEventListener('pagehide', onPageHide);
    const stop = startSessionIdleMonitor(() => {
      ending = true;
      pending = false;
      window.clearTimeout(syncTimer);
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
    }, onActivity);
    return () => {
      ending = true;
      window.clearTimeout(syncTimer);
      window.removeEventListener('pagehide', onPageHide);
      stop();
    };
  }, [authenticated]);
}
