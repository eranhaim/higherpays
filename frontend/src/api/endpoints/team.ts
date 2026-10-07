import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { WorkspaceRole } from '../types';
import type { Permission } from '../../rbac/permissions';
import type { PayModel } from './accounts';

export type MemberStatus = 'active' | 'suspended' | 'removed';

/** Anyone with access to the workspace, and the profile behind their role. */
export interface Member {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  roleName: string;
  permissions: Permission[];
  status: MemberStatus;
  agentId: string | null;
  accountId: string | null;
  accountName: string | null;
  accountStatus: 'active' | 'paused' | 'archived' | null;
  isSelf: boolean;
  joinedAt: string;
  /** Sent to a caller with team.manage: this seat refuses every edit. */
  isPlatformAdmin?: boolean;
  // Withheld by the server, not merely hidden: customer volume and the
  // assignment roster need data.view_all, and the pay terms need
  // revenue.view. Undefined means the caller may not see the figure.
  totalCustomerPaid?: number | null;
  assignedCount?: number | null;
  payModel?: PayModel;
  revenueSplitPct?: number;
  salaryAmount?: number;
  commissionPct?: number;
}

export const teamApi = {
  create: (input: { email: string; password: string; fullName?: string; role: 'workspace_admin' | 'member'; permissions: Permission[] }) =>
    api.post<{ userId: string; role: string }>(workspacePath('/team'), input),

  async list(range?: { from?: string; to?: string }): Promise<Member[]> {
    const search = new URLSearchParams();
    if (range?.from) search.set('from', range.from);
    if (range?.to) search.set('to', range.to);
    const raw = await api.get<{ members: Member[] }>(`${workspacePath('/team')}${search.size ? `?${search}` : ''}`);
    return raw.members;
  },

  /** Active and suspended are direct access controls; removed is set through remove(). */
  setStatus: (userId: string, status: Exclude<MemberStatus, 'removed'>) =>
    api.patch<{ userId: string; status: MemberStatus }>(workspacePath(`/team/${userId}/status`), { status }),

  update: (userId: string, input: {
    fullName?: string; email?: string; role?: 'workspace_admin' | 'member';
    permissions?: Permission[]; password?: string; passwordConfirm?: string;
  }) => api.patch<Member>(workspacePath(`/team/${userId}`), input),

  transferOwner: (userId: string) =>
    api.post<{ ownerUserId: string }>(workspacePath('/team/owner-transfer'), { userId }),

  /** Marks a plain seat removed while preserving its history. */
  remove: (userId: string) => api.del<void>(workspacePath(`/team/${userId}`)),
};
