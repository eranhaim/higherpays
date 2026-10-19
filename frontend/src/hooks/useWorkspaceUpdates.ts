import { useEffect } from 'react';
import { authApi } from '../api/endpoints';
import { apiBaseUrl } from '../api/http';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../store/auth';
import { useSessionStore } from '../store/session';

const RECONNECT_MS = 2_000;

interface WorkspaceUpdate {
  workspaceId: string;
}

function invalidateWorkspaceQueries(workspaceId: string) {
  queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[1] === workspaceId,
    refetchType: 'active',
  });
  queryClient.invalidateQueries({ queryKey: ['platform-overview'], refetchType: 'active' });
  queryClient.invalidateQueries({ queryKey: ['platform-workspaces'], refetchType: 'active' });
}

function readEvents(chunk: string, onUpdate: (event: WorkspaceUpdate) => void) {
  for (const message of chunk.split(/\r?\n\r?\n/)) {
    const data = message.split(/\r?\n/).find((line) => line.startsWith('data: '));
    if (!data) continue;
    try {
      const event = JSON.parse(data.slice(6)) as WorkspaceUpdate;
      if (event.workspaceId) onUpdate(event);
    } catch {
      // Ignore malformed messages and wait for the next complete event.
    }
  }
}

export function useWorkspaceUpdates() {
  const accessToken = useAuthStore((state) => state.accessToken);

  useEffect(() => {
    if (!accessToken) return;

    const controller = new AbortController();
    const decoder = new TextDecoder();
    let reconnectTimer: number | undefined;
    let stopped = false;

    const reconnect = () => {
      if (!stopped) reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
    };

    const refresh = async (): Promise<boolean> => {
      try {
        const session = await authApi.refresh();
        useAuthStore.getState().setTokens(session.accessToken, session.refreshToken);
        return true;
      } catch {
        useAuthStore.getState().clear();
        useSessionStore.getState().clear();
        window.location.assign('/login');
        return false;
      }
    };

    const connect = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/events`, {
          headers: { Authorization: `Bearer ${useAuthStore.getState().accessToken}` },
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          if (response.status === 401) {
            await refresh();
            return;
          }
          reconnect();
          return;
        }

        const reader = response.body.getReader();
        let pending = '';
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const complete = pending.lastIndexOf('\n\n');
          if (complete === -1) continue;
          readEvents(pending.slice(0, complete), (event) => invalidateWorkspaceQueries(event.workspaceId));
          pending = pending.slice(complete + 2);
        }
        reconnect();
      } catch {
        if (!controller.signal.aborted) reconnect();
      }
    };

    connect();
    return () => {
      stopped = true;
      controller.abort();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    };
  }, [accessToken]);
}
