/**
 * Session state — what the user is looking at *right now*.
 *
 * Owns the active workspace id (the value we send as `X-Workspace-Id` on every
 * request) and derived helpers. Everything else (accounts, links, ...) is
 * server data owned by React Query.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface SessionState {
  activeWorkspaceId: string | null;
  setActiveWorkspaceId: (id: string | null) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      activeWorkspaceId: null,
      setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),
      clear: () => set({ activeWorkspaceId: null }),
    }),
    {
      name: 'higherpays.session',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
