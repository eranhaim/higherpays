/**
 * Shared API contract types. Each endpoint module reuses these.
 *
 * These live under `api/` so it is obvious which types are what the backend
 * actually sends, as opposed to UI-facing shapes derived in hooks.
 */

/** Built-in workspace roles. Custom roles are free-form strings. */
export type SystemRole = 'owner' | 'admin' | 'manager' | 'analyst' | 'chatter' | 'creator';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  twoFactorEnabled: boolean;
}

export interface AuthWorkspace {
  id: string;
  name: string;
  role: string;
  status?: string;
  currency?: string;
  organization?: string;
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
