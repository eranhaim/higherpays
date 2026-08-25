/**
 * Unified view of "who am I, where am I, and how am I connected?".
 * Pages read from this hook rather than three different stores.
 */

import { useAuthStore } from '../store/auth';
import { useSessionStore } from '../store/session';
import type { Role, AuthWorkspace } from '../api/types';

export interface CurrentSession {
  /** Kept in the returned shape so consumers don't have to change. Always false. */
  isDemo: false;
  isAuthenticated: boolean;
  userName: string;
  role: Role;
  activeWorkspaceId: string | null;
  activeWorkspace: AuthWorkspace | null;
  workspaces: AuthWorkspace[];
  currency: string;
}

export function useCurrentSession(): CurrentSession {
  const authUser = useAuthStore((s) => s.user);
  const authWorkspaces = useAuthStore((s) => s.workspaces);
  const activeWorkspaceId = useSessionStore((s) => s.activeWorkspaceId);

  const active =
    authWorkspaces.find((w) => w.id === activeWorkspaceId) ??
    authWorkspaces[0] ??
    null;

  return {
    isDemo: false,
    isAuthenticated: Boolean(authUser),
    userName: authUser?.fullName ?? 'Signed in',
    role: (active?.role ?? 'analyst') as Role,
    activeWorkspaceId: active?.id ?? null,
    activeWorkspace: active,
    workspaces: authWorkspaces,
    currency: active?.currency ?? 'EUR',
  };
}
