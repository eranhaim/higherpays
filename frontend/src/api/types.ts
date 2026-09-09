/**
 * Shared API contract types. Each endpoint module reuses these.
 *
 * These live under `api/` so it is obvious which types are what the backend
 * actually sends, as opposed to UI-facing shapes derived in hooks.
 */

/** System roles have stable keys; custom role keys are workspace data. */
export type SystemWorkspaceRole = 'workspace_owner' | 'workspace_admin' | 'analyst' | 'agent' | 'account_owner';
export type WorkspaceRole = SystemWorkspaceRole | (string & {});

export const WORKSPACE_ROLES: SystemWorkspaceRole[] = ['workspace_owner', 'workspace_admin', 'analyst', 'agent', 'account_owner'];

/** What this agency calls a creator and an agent. */
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
  roleName: string;
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
