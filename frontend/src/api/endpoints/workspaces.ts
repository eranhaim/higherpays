import { api } from '../http';
import { workspacePath } from '../workspacePath';

/** Response from `GET /workspaces/:wid/platform-fee`. */
export interface PlatformFee {
  blendedRatePct: number;
  pspFixedFee: number;
  providerRefundAvailable: boolean;
  // Treasury settings reach only callers who see the whole workspace; the
  // blended rate and fixed fee above are what the link fee preview needs.
  refundFee?: number;
  chargebackFee?: number;
  declineFee?: number;
  reservePct?: number;
  reserveReleaseDays?: number;
  /** Only present when the caller is a platform operator. */
  pspRatePct?: number;
  marginRatePct?: number;
}

/** A workspace this user belongs to, from `GET /auth/me/workspaces`. */
export interface MyWorkspace {
  id: string;
  name: string;
  role: string;
  status: string;
  currency: string;
  organization: string;
}

export interface LinkLimits {
  minLinkAmount: number | null;
  maxLinkAmount: number | null;
  providerMinimum: number;
}

export interface WorkspacePermissions {
  workspaceId: string;
  role: string;
  permissions: string[];
}

export const workspacesApi = {
  getPlatformFee: () =>
    api.get<PlatformFee>(workspacePath('/platform-fee')),

  getLinkLimits: () =>
    api.get<LinkLimits>(workspacePath('/link-limits')),

  setLinkLimits: (input: { minLinkAmount?: number | null; maxLinkAmount?: number | null }) =>
    api.patch<LinkLimits>(workspacePath('/link-limits'), input),

  getPermissions: () =>
    api.get<WorkspacePermissions>(workspacePath('/permissions')),

  rename: (name: string) =>
    api.patch<{ id: string; name: string }>(workspacePath(''), { name }),

  /** Every workspace this user belongs to — not scoped to the active one. */
  async listMine(): Promise<MyWorkspace[]> {
    const raw = await api.get<{ workspaces: MyWorkspace[] }>('/auth/me/workspaces', { skipWorkspace: true });
    return raw.workspaces;
  },

  /** Adds a brand/MID under the active workspace's organization. */
  create: (input: { name: string; currency?: string }) =>
    api.post<{ id: string; name: string; currency: string; webhookEndpointId: string }>('/workspaces', input),
};
