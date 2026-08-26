/**
 * Who am I and which workspace am I looking at.
 *
 * Pages read from this hook rather than from the auth and session stores
 * directly, so the "active workspace" rule lives in one place.
 */

import { useAuthStore } from '../store/auth';
import { useSessionStore } from '../store/session';
import type { AuthUser, AuthWorkspace, WorkspaceLabels, WorkspaceRole } from '../api/types';

const DEFAULT_LABELS: WorkspaceLabels = { account: 'Account', accounts: 'Accounts', agent: 'Agent', agents: 'Agents' };

export interface CurrentSession {
  isAuthenticated: boolean;
  user: AuthUser | null;
  /** null when no workspace is resolved yet — grants nothing until it is. */
  role: WorkspaceRole | null;
  activeWorkspaceId: string | null;
  activeWorkspace: AuthWorkspace | null;
  workspaces: AuthWorkspace[];
  currency: string;
  /** What this agency calls its accounts and agents. */
  labels: WorkspaceLabels;
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
    // No workspace means no role. Defaulting to a real role here would hand a
    // half-loaded or tampered session that role's whole sidebar.
    role: activeWorkspace?.role ?? null,
    activeWorkspaceId: activeWorkspace?.id ?? null,
    activeWorkspace,
    workspaces,
    currency: activeWorkspace?.currency ?? 'EUR',
    labels: activeWorkspace?.labels ?? DEFAULT_LABELS,
  };
}
