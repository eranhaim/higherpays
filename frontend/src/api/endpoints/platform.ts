import { api } from '../http';

/**
 * The HigherPays operator tier, above every tenant. These calls are NOT
 * workspace-scoped — they cross agencies — so each one skips the workspace
 * header. Access is gated by `platform_admins`, not by a workspace role.
 */

export type PlatformRole = 'super_admin' | 'support' | 'finance';

export interface PlatformWorkspace {
  id: string;
  name: string;
  currency: string;
  status: string;
  organization: string;
  organizationId: string;
  accounts: number;
  members: number;
  approvedTxns: number;
  grossVolume: number;
  lastActivity: string | null;
}

interface RawPlatformWorkspace {
  id: string;
  name: string;
  currency: string;
  status: string;
  organization: string;
  organization_id: string;
  accounts: number | string;
  members: number | string;
  approved_txns: number | string;
  gross_volume: number | string;
  last_activity: string | null;
}

const n = (v: unknown): number => {
  const parsed = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const platformApi = {
  /** Who am I at the platform tier, or 403 if I am not an operator at all. */
  me: () => api.get<{ role: PlatformRole }>('/platform/me', { skipWorkspace: true }),

  async listWorkspaces(): Promise<PlatformWorkspace[]> {
    const raw = await api.get<{ workspaces: RawPlatformWorkspace[] }>(
      '/platform/workspaces', { skipWorkspace: true });
    return raw.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      currency: w.currency,
      status: w.status,
      organization: w.organization,
      organizationId: w.organization_id,
      accounts: n(w.accounts),
      members: n(w.members),
      approvedTxns: n(w.approved_txns),
      grossVolume: n(w.gross_volume),
      lastActivity: w.last_activity,
    }));
  },
};
