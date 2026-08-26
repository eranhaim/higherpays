/**
 * Shared API contract types. Each endpoint module reuses these.
 *
 * These live under `api/` so it is obvious which types are what the backend
 * actually sends, as opposed to UI-facing shapes derived in hooks.
 */

/** Mirrors WORKSPACE_ROLE in backend/src/schema/entities.js. */
export type WorkspaceRole = 'workspace_admin' | 'analyst' | 'agent' | 'account_owner';

export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  workspace_admin: 'Admin',
  analyst: 'Analyst',
  agent: 'Agent',
  account_owner: 'Account owner',
};

/** What this agency calls an account and an agent. */
export interface WorkspaceLabels {
  account: string;
  accounts: string;
  agent: string;
  agents: string;
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  isPlatformAdmin: boolean;
  twoFactorEnabled: boolean;
}

export interface AuthWorkspace {
  id: string;
  name: string;
  role: WorkspaceRole;
  status: string;
  currency: string;
  labels: WorkspaceLabels;
}

export interface LoginSuccess {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
  workspaces: AuthWorkspace[];
}

export interface TwoFactorRequired {
  twoFactorRequired: true;
}

export type LoginResponse = LoginSuccess | TwoFactorRequired;

export function isTwoFactorRequired(r: LoginResponse): r is TwoFactorRequired {
  return 'twoFactorRequired' in r && r.twoFactorRequired === true;
}

/** One page of a keyset-paginated list. `nextCursor` is null on the last page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
