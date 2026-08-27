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

export interface PlatformOverview {
  counts: { workspaces: number; workspaces_active: number; accounts: number; agents: number; users: number };
  money: { gross: number; psp_fees: number; platform_fees: number; higherpays_margin: number; sales: number };
}

/** The whole onboarding of an agency in one request. */
export interface OnboardAgencyInput {
  name: string;
  currency: string;
  merchantId?: string;
  adminEmail: string;
  pspRatePct: number;
  marginRatePct: number;
  pspFixedFee: number;
  chargebackFee: number;
  refundFee: number;
  declineFee: number;
  accountSplitPct: number;
  agentPct: number;
}

/** One versioned rate row: what the agency pays on every sale. */
export interface PlatformFeeRate {
  pspRatePct: number;
  marginRatePct: number;
  pspFixedFee: number;
}

/** The reversal fees and the rolling reserve, also versioned. */
export interface SettlementFee {
  chargebackFee: number;
  refundFee: number;
  declineFee: number;
  settlementFeePct: number;
  settlementFeeFlat: number;
  reservePct: number;
  reserveReleaseDays: number;
}

export interface PlatformWorkspaceDetail {
  id: string;
  name: string;
  /** Newest first; the first row is what the agency pays today. */
  feeHistory: PlatformFeeRate[];
  settlementFee: SettlementFee | null;
}

const opts = { skipWorkspace: true };

export const platformApi = {
  /** 403 if the caller is not a platform admin. */
  me: () => api.get<{ isPlatformAdmin: true }>('/platform/me', opts),

  // Postgres aggregates arrive as strings; the page does arithmetic on them.
  async overview(): Promise<PlatformOverview> {
    const raw = await api.get<{ counts: Record<string, string | number>; money: Record<string, string | number> }>('/platform/overview', opts);
    const num = (o: Record<string, string | number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));
    return { counts: num(raw.counts) as PlatformOverview['counts'], money: num(raw.money) as PlatformOverview['money'] };
  },

  async listWorkspaces(): Promise<PlatformWorkspace[]> {
    const raw = await api.get<{ workspaces: PlatformWorkspace[] }>('/platform/workspaces', opts);
    return raw.workspaces;
  },

  onboardAgency: (input: OnboardAgencyInput) =>
    api.post<{ workspaceId: string; name: string; webhookEndpointId: string; blendedRatePct: number }>('/platform/agencies', input, opts),

  setStatus: (id: string, status: 'active' | 'suspended') =>
    api.patch<{ id: string; name: string; status: string }>(`/platform/workspaces/${id}/status`, { status }, opts),

  getWorkspace: (id: string) => api.get<PlatformWorkspaceDetail>(`/platform/workspaces/${id}`, opts),

  /** A new versioned rate row; the history is kept server-side. */
  setPlatformFee: (id: string, input: PlatformFeeRate) =>
    api.put<{ blendedRatePct: number }>(`/platform/workspaces/${id}/platform-fee`, { ...input, feeModel: 'flat' }, opts),

  setSettlementFee: (id: string, input: SettlementFee) =>
    api.put<SettlementFee>(`/platform/workspaces/${id}/settlement-fee`, input, opts),
};
