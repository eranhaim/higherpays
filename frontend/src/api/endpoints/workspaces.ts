import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { WorkspaceLabels, WorkspaceRole } from '../types';

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
}

export interface UpdateWorkspaceInput {
  name?: string;
  accountLabel?: string;
  accountLabelPlural?: string;
  agentLabel?: string;
  agentLabelPlural?: string;
}

export interface LinkLimits {
  minLinkAmount: number | null;
  maxLinkAmount: number | null;
  providerMinimum: number;
}

export interface WorkspacePermissions {
  workspaceId: string;
  role: WorkspaceRole;
  permissions: string[];
}

export const workspacesApi = {
  get: () => api.get<WorkspaceSettings>(workspacePath('')),

  update: (input: UpdateWorkspaceInput) => api.patch<WorkspaceSettings>(workspacePath(''), input),

  getPlatformFee: () => api.get<PlatformFee>(workspacePath('/platform-fee')),

  getLinkLimits: () => api.get<LinkLimits>(workspacePath('/link-limits')),

  setLinkLimits: (input: { minLinkAmount?: number | null; maxLinkAmount?: number | null }) =>
    api.patch<LinkLimits>(workspacePath('/link-limits'), input),

  getPermissions: () => api.get<WorkspacePermissions>(workspacePath('/permissions')),
};
