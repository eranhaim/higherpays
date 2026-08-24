/**
 * Who am I and which workspace am I looking at.
 *
 * Pages read from this hook rather than from the auth and session stores
 * directly, so the "active workspace" rule lives in one place.
 */

import { useAuthStore } from '../store/auth';
import { useSessionStore } from '../store/session';
import type { AuthUser, AuthWorkspace } from '../api/types';

export interface CurrentSession {
  isAuthenticated: boolean;
  user: AuthUser | null;
  role: string;
  activeWorkspaceId: string | null;
  activeWorkspace: AuthWorkspace | null;
  workspaces: AuthWorkspace[];
  currency: string;
}

export function useCurrentSession(): CurrentSession {
  const user = useAuthStore((s) => s.user);
  const workspaces = useAuthStore((s) => s.workspaces);
  const activeWorkspaceId = useSessionStore((s) => s.activeWorkspaceId);

  const activeWorkspace =
    workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null;

  return {
    isAuthenticated: Boolean(user),
    user,
    role: activeWorkspace?.role ?? 'analyst',
    activeWorkspaceId: activeWorkspace?.id ?? null,
    activeWorkspace,
    workspaces,
    currency: activeWorkspace?.currency ?? 'EUR',
  };
}
