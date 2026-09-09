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
  originalSession: {
    accessToken: string;
    refreshToken: string;
    user: AuthUser;
    workspaces: AuthWorkspace[];
  } | null;
  impersonationExpiresAt: string | null;
  originalWorkspaceId: string | null;

  setSession: (input: {
    accessToken: string;
    refreshToken: string;
    user: AuthUser;
    workspaces: AuthWorkspace[];
  }) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
  setUser: (user: AuthUser) => void;
  setWorkspaces: (workspaces: AuthWorkspace[]) => void;
  beginImpersonation: (input: {
    accessToken: string;
    expiresAt: string;
    user: AuthUser;
    workspace: AuthWorkspace;
    originalWorkspaceId: string | null;
  }) => void;
  endImpersonation: () => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      workspaces: [],
      originalSession: null,
      impersonationExpiresAt: null,
      originalWorkspaceId: null,

      setSession: ({ accessToken, refreshToken, user, workspaces }) =>
        set({
          accessToken, refreshToken, user, workspaces,
          originalSession: null, impersonationExpiresAt: null,
          originalWorkspaceId: null,
        }),

      setTokens: (accessToken, refreshToken) =>
        set({ accessToken, refreshToken }),

      setUser: (user) => set({ user }),

      setWorkspaces: (workspaces) => set({ workspaces }),

      beginImpersonation: ({ accessToken, expiresAt, user, workspace, originalWorkspaceId }) =>
        set((state) => ({
          originalSession: state.originalSession ?? (
            state.accessToken && state.refreshToken && state.user
              ? {
                  accessToken: state.accessToken,
                  refreshToken: state.refreshToken,
                  user: state.user,
                  workspaces: state.workspaces,
                }
              : null
          ),
          accessToken,
          refreshToken: null,
          user,
          workspaces: [workspace],
          impersonationExpiresAt: expiresAt,
          originalWorkspaceId,
        })),

      endImpersonation: () =>
        set((state) => state.originalSession ? {
          ...state.originalSession,
          originalSession: null,
          impersonationExpiresAt: null,
          originalWorkspaceId: null,
        } : {
          accessToken: null,
          refreshToken: null,
          user: null,
          workspaces: [],
          originalSession: null,
          impersonationExpiresAt: null,
          originalWorkspaceId: null,
        }),

      clear: () =>
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          workspaces: [],
          originalSession: null,
          impersonationExpiresAt: null,
          originalWorkspaceId: null,
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
        originalSession: s.originalSession,
        impersonationExpiresAt: s.impersonationExpiresAt,
        originalWorkspaceId: s.originalWorkspaceId,
      }),
    },
  ),
);

/** Selector: has a live session. Prefer this over reading `accessToken`. */
export function useIsAuthenticated(): boolean {
  return useAuthStore((s) => Boolean(s.accessToken && s.user));
}
