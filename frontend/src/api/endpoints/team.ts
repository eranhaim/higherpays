import { api } from '../http';
import { workspacePath } from '../workspacePath';

export type MemberStatus = 'active' | 'suspended';

/** Anyone with access to the workspace, and the profile behind their role. */
export interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
  status: MemberStatus;
  agentId: string | null;
  accountId: string | null;
  accountName: string | null;
  isSelf: boolean;
  joinedAt: string;
}

export const teamApi = {
  async list(): Promise<Member[]> {
    const raw = await api.get<{ members: Member[] }>(workspacePath('/team'));
    return raw.members;
  },

  /** Suspending ends the sign-in but keeps the agent or account record. */
  setStatus: (userId: string, status: MemberStatus) =>
    api.patch<{ userId: string; status: MemberStatus }>(workspacePath(`/team/${userId}/status`), { status }),

  setRole: (userId: string, role: string) =>
    api.patch<{ userId: string; role: string }>(workspacePath(`/team/${userId}/role`), { role }),

  /** Removes access entirely. Refused while an agent or account record exists. */
  remove: (userId: string) => api.del<void>(workspacePath(`/team/${userId}`)),
};
