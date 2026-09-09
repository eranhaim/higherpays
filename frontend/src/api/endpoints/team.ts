import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { WorkspaceRole } from '../types';

export type MemberStatus = 'active' | 'suspended' | 'removed';

/** Anyone with access to the workspace, and the profile behind their role. */
export interface Member {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  roleName: string;
  status: MemberStatus;
  agentId: string | null;
  accountId: string | null;
  accountName: string | null;
  accountStatus: 'active' | 'paused' | 'archived' | null;
  isSelf: boolean;
  joinedAt: string;
}

export const teamApi = {
  async list(): Promise<Member[]> {
    const raw = await api.get<{ members: Member[] }>(workspacePath('/team'));
    return raw.members;
  },

  /** Active and suspended are direct access controls; removed is set through remove(). */
  setStatus: (userId: string, status: Exclude<MemberStatus, 'removed'>) =>
    api.patch<{ userId: string; status: MemberStatus }>(workspacePath(`/team/${userId}/status`), { status }),

  setRole: (userId: string, role: string) =>
    api.patch<{ userId: string; role: string }>(workspacePath(`/team/${userId}/role`), { role }),

  transferOwner: (userId: string) =>
    api.post<{ ownerUserId: string }>(workspacePath('/team/owner-transfer'), { userId }),

  /** Marks a plain seat removed while preserving its history. */
  remove: (userId: string) => api.del<void>(workspacePath(`/team/${userId}`)),
};
