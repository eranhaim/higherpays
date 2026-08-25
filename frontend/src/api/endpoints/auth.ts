import { api } from '../http';
import type { AuthUser, AuthWorkspace, LoginResponse } from '../types';

export interface TwoFactorSetup {
  secret: string;
  otpauthUrl: string;
}

/** A signed-in device: one refresh-token family. */
export interface Session {
  id: string;
  userAgent: string | null;
  ip: string | null;
  lastRefreshedAt: string;
  expiresAt: string;
  /** The session this browser is signed in on. */
  isCurrent: boolean;
}

export const authApi = {
  login(email: string, password: string, totp?: string) {
    return api.post<LoginResponse>(
      '/auth/login',
      { email, password, ...(totp ? { totp } : {}) },
      { skipWorkspace: true },
    );
  },

  refresh(refreshToken: string) {
    return api.post<{ accessToken: string; refreshToken: string }>(
      '/auth/refresh',
      { refreshToken },
      { skipRefresh: true, skipWorkspace: true },
    );
  },

  logout(refreshToken: string | null) {
    return api.post<void>(
      '/auth/logout',
      refreshToken ? { refreshToken } : {},
      { skipWorkspace: true },
    );
  },

  me() {
    return api.get<{ user: AuthUser; workspaces: AuthWorkspace[] }>(
      '/auth/me',
      { skipWorkspace: true },
    );
  },

  myWorkspaces() {
    return api.get<{ workspaces: AuthWorkspace[] }>(
      '/auth/me/workspaces',
      { skipWorkspace: true },
    );
  },

  /** Creates a pending TOTP secret. Not active until `enableTwoFactor` confirms a code. */
  setupTwoFactor() {
    return api.post<TwoFactorSetup>('/auth/2fa/setup', {}, { skipWorkspace: true });
  },

  enableTwoFactor(code: string) {
    return api.post<{ enabled: true }>('/auth/2fa/enable', { code }, { skipWorkspace: true });
  },

  disableTwoFactor(code: string) {
    return api.post<{ enabled: false }>('/auth/2fa/disable', { code }, { skipWorkspace: true });
  },

  async listSessions(): Promise<Session[]> {
    const raw = await api.get<{ sessions: Session[] }>('/auth/sessions', { skipWorkspace: true });
    return raw.sessions;
  },

  revokeSession(id: string) {
    return api.del<void>(`/auth/sessions/${id}`, { skipWorkspace: true });
  },

  /** Signs out every other device; the caller proves which one to keep with its refresh token. */
  revokeOtherSessions(refreshToken: string) {
    return api.post<{ revoked: number }>('/auth/sessions/revoke-others', { refreshToken }, { skipWorkspace: true });
  },
};
