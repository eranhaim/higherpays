import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { Page, WorkspaceLabels, WorkspaceRole } from '../types';

/**
 * One currency an agency may transact in.
 *
 * Mirrors workspace_currencies (backend/src/schema/entities.js). The amounts
 * are already resolved: an inherited checkout fee arrives as the rate card's
 * value with `checkoutFeeInherited` set.
 */
export interface WorkspaceCurrency {
  currency: string;
  checkoutFee: number;
  checkoutFeeInherited: boolean;
  minLinkAmount: number | null;
  maxLinkAmount: number | null;
  /** The agency's base currency: what reports default to, and what a salary is paid in. */
  isBase: boolean;
  hasActivity: boolean;
  /**
   * False when MantaPay cannot charge in it. Such a currency is reportable but
   * no link may be priced in it, so the link form must not offer it.
   */
  checkoutSupported: boolean;
}

/** Response from `GET /workspaces/:wid/platform-fee`. */
export interface PlatformFee {
  /** Which currency the flat amounts below are in. */
  currency: string;
  blendedRatePct: number;
  pspRatePct: number;
  settlementPct: number;
  marginRatePct: number;
  pspFixedFee: number;
  checkoutFee: number;
  providerRefundAvailable: boolean;
  // Treasury settings reach only callers who see the whole workspace; the
  // blended rate and fixed fee above are what the link fee preview needs.
  refundFee?: number;
  chargebackFee?: number;
  declineFee?: number;
  reservePct?: number;
  reserveReleaseDays?: number;
}

export interface WorkspaceSettings {
  id: string;
  name: string;
  currency: string;
  status: string;
  labels: WorkspaceLabels;
  minLinkAmount: number | null;
  maxLinkAmount: number | null;
  /** The MID MantaPay knows this agency by. Null falls back to the server default. */
  merchantId: string | null;
  /** The path segment MantaPay must be told to notify. */
  webhookEndpointId: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
  accountLabel?: string;
  accountLabelPlural?: string;
  agentLabel?: string;
  agentLabelPlural?: string;
  merchantId?: string | null;
}

export interface LinkLimits {
  /** Which currency these amounts are in. */
  currency: string;
  minLinkAmount: number | null;
  maxLinkAmount: number | null;
  /** How long a single-use link lives. Always a number: the platform default when unset. */
  linkTtlMinutes: number;
  reusableLinksEnabled: boolean;
  providerMinimum: number;
}

export interface WorkspacePermissions {
  workspaceId: string;
  role: WorkspaceRole;
  roleName: string;
  permissions: string[];
}

/** One line of the workspace's activity log. */
export interface AuditEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
  actor: { name: string; email: string } | null;
  effectiveUser: { name: string; email: string } | null;
}

export const workspacesApi = {
  get: () => api.get<WorkspaceSettings>(workspacePath('')),

  update: (input: UpdateWorkspaceInput) => api.patch<WorkspaceSettings>(workspacePath(''), input),

  /** Every currency this agency may transact in, base first. */
  listCurrencies: () => api
    .get<{ currencies: WorkspaceCurrency[] }>(workspacePath('/currencies'))
    .then((r) => r.currencies),

  // The flat amounts in both of these are per currency, so both take one.
  getPlatformFee: (currency?: string) =>
    api.get<PlatformFee>(workspacePath(`/platform-fee${currency ? `?currency=${currency}` : ''}`)),

  getLinkLimits: (currency?: string) =>
    api.get<LinkLimits>(workspacePath(`/link-limits${currency ? `?currency=${currency}` : ''}`)),

  setLinkLimits: (input: {
    minLinkAmount?: number | null;
    maxLinkAmount?: number | null;
    linkTtlMinutes?: number;
    reusableLinksEnabled?: boolean;
  }) =>
    api.patch<LinkLimits>(workspacePath('/link-limits'), input),

  getPermissions: () => api.get<WorkspacePermissions>(workspacePath('/permissions')),

  listAudit(cursor: string | null = null): Promise<Page<AuditEntry>> {
    const qs = new URLSearchParams({ limit: '50' });
    if (cursor) qs.set('cursor', cursor);
    return api.get<Page<AuditEntry>>(workspacePath(`/audit?${qs.toString()}`));
  },
};
