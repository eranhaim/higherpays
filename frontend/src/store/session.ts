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
  /** The currency the user chose to read money in, per workspace. */
  reportingCurrency: Record<string, string>;
  setActiveWorkspaceId: (id: string | null) => void;
  setReportingCurrency: (workspaceId: string, currency: string) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      activeWorkspaceId: null,
      reportingCurrency: {},
      setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),
      setReportingCurrency: (workspaceId, currency) =>
        set((s) => ({ reportingCurrency: { ...s.reportingCurrency, [workspaceId]: currency } })),
      clear: () => set({ activeWorkspaceId: null, reportingCurrency: {} }),
    }),
    {
      name: 'higherpays.session',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
