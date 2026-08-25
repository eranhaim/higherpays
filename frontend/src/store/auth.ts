/**
 * Authentication state.
 *
 * Owns the JWT + refresh token pair, the current user record, and the list of
 * workspaces this user has memberships in. Persisted to localStorage so a page
 * refresh doesn't log the user out.
 *
 * Deliberately does NOT own:
 * - The active workspace id -> `sessionStore`
 * - Preferences (timezone, density, ...) -> `preferencesStore`
 * - Any business entity (accounts, links, ...) -> React Query
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AuthUser, AuthWorkspace } from '../api/types';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  workspaces: AuthWorkspace[];

  setSession: (input: {
    accessToken: string;
    refreshToken: string;
    user: AuthUser;
    workspaces: AuthWorkspace[];
  }) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
  setUser: (user: AuthUser) => void;
  setWorkspaces: (workspaces: AuthWorkspace[]) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      workspaces: [],

      setSession: ({ accessToken, refreshToken, user, workspaces }) =>
        set({ accessToken, refreshToken, user, workspaces }),

      setTokens: (accessToken, refreshToken) =>
        set({ accessToken, refreshToken }),

      setUser: (user) => set({ user }),

      setWorkspaces: (workspaces) => set({ workspaces }),

      clear: () =>
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          workspaces: [],
        }),
    }),
    {
      name: 'higherpays.auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
        user: s.user,
        workspaces: s.workspaces,
      }),
    },
  ),
);

/** Selector: has a live session. Prefer this over reading `accessToken`. */
export function useIsAuthenticated(): boolean {
  return useAuthStore((s) => Boolean(s.accessToken && s.user));
}
