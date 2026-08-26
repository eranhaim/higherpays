import { api } from '../http';

/**
 * The HigherPays operator tier, above every workspace. These calls cross
 * agencies, so each one skips the workspace header. Access comes from
 * `users.is_platform_admin`, not from a workspace role.
 */

export interface PlatformWorkspace {
  id: string;
  name: string;
  currency: string;
  status: string;
  merchantId: string | null;
  createdAt: string;
  accounts: number;
  agents: number;
  members: number;
  paidPayments: number;
  grossVolume: number;
  lastActivity: string | null;
  blendedRatePct: number;
}

export const platformApi = {
  /** 403 if the caller is not a platform admin. */
  me: () => api.get<{ isPlatformAdmin: true }>('/platform/me', { skipWorkspace: true }),

  async listWorkspaces(): Promise<PlatformWorkspace[]> {
    const raw = await api.get<{ workspaces: PlatformWorkspace[] }>('/platform/workspaces', { skipWorkspace: true });
    return raw.workspaces;
  },

  /**
   * Set the MID MantaPay knows this agency by. Passing null clears it, which
   * falls the server back to MANTAPAY_MERCHANT_ID.
   */
  setMerchantId: (id: string, merchantId: string | null) =>
    api.patch<{ id: string; name: string; merchantId: string | null }>(
      `/platform/workspaces/${id}/merchant-id`, { merchantId }, { skipWorkspace: true }),
};
