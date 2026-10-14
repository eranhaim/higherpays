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
  /**
   * Which currency the money pages are reporting, per workspace.
   *
   * Kept per workspace because a GBP selection means nothing in a EUR-only
   * agency, and shared across pages because Payments, Links and Payouts
   * showing three different currencies at once is how someone reads one
   * currency's total next to another's rows. Unset means the base currency.
   */
  reportingCurrency: Record<string, string>;
  setReportingCurrency: (workspaceId: string, currency: string) => void;
  clear: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      activeWorkspaceId: null,
      setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),
      reportingCurrency: {},
      setReportingCurrency: (workspaceId, currency) => set((s) => ({
        reportingCurrency: { ...s.reportingCurrency, [workspaceId]: currency },
      })),
      clear: () => set({ activeWorkspaceId: null, reportingCurrency: {} }),
    }),
    {
      name: 'higherpays.session',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
