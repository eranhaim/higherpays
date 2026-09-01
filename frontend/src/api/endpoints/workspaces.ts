import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { Page, WorkspaceLabels, WorkspaceRole } from '../types';

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
  minLinkAmount: number | null;
  maxLinkAmount: number | null;
  /** How long a single-use link lives. Always a number: the platform default when unset. */
  linkTtlMinutes: number;
  providerMinimum: number;
}

export interface WorkspacePermissions {
  workspaceId: string;
  role: WorkspaceRole;
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
}

export const workspacesApi = {
  get: () => api.get<WorkspaceSettings>(workspacePath('')),

  update: (input: UpdateWorkspaceInput) => api.patch<WorkspaceSettings>(workspacePath(''), input),

  getPlatformFee: () => api.get<PlatformFee>(workspacePath('/platform-fee')),

  getLinkLimits: () => api.get<LinkLimits>(workspacePath('/link-limits')),

  setLinkLimits: (input: { minLinkAmount?: number | null; maxLinkAmount?: number | null; linkTtlMinutes?: number }) =>
    api.patch<LinkLimits>(workspacePath('/link-limits'), input),

  getPermissions: () => api.get<WorkspacePermissions>(workspacePath('/permissions')),

  listAudit(cursor: string | null = null): Promise<Page<AuditEntry>> {
    const qs = new URLSearchParams({ limit: '50' });
    if (cursor) qs.set('cursor', cursor);
    return api.get<Page<AuditEntry>>(workspacePath(`/audit?${qs.toString()}`));
  },
};
