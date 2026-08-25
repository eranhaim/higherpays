import { api } from '../http';
import { workspacePath } from '../workspacePath';

export type AgentStatus = 'active' | 'offline';
export type AgentShift = 'Day' | 'Night';

/**
 * A agent membership. The backend calls the endpoint "memberships" but the
 * response is scoped to agent-role users only; other role rows are dropped.
 */
export interface Agent {
  membershipId: string;
  name: string;
  email: string;
  status: AgentStatus;
  shift: AgentShift;
  commissionPct: number | null;
}

interface RawAgent {
  membershipId: string;
  name: string;
  email: string;
  status: AgentStatus;
  shift: AgentShift;
  commissionPct: number | string | null;
}

/** Anyone with an active seat in the workspace, whatever their role. */
export interface Member {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  isSelf: boolean;
  joinedAt: string;
}

function toNullableNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

export const membershipsApi = {
  async listAgents(): Promise<Agent[]> {
    const raw = await api.get<{ agents: RawAgent[] }>(workspacePath('/memberships'));
    return raw.agents.map((c) => ({
      membershipId: c.membershipId,
      name: c.name,
      email: c.email,
      status: c.status,
      shift: c.shift,
      commissionPct: toNullableNumber(c.commissionPct),
    }));
  },

  async listMembers(): Promise<Member[]> {
    const raw = await api.get<{ members: Member[] }>(workspacePath('/memberships/members'));
    return raw.members;
  },

  setCommissionPct(membershipId: string, commissionPct: number | null) {
    return api.patch<{ id: string; commissionPct: number | null }>(
      workspacePath(`/memberships/${membershipId}`),
      { commissionPct },
    );
  },

  setRole(membershipId: string, role: string) {
    return api.patch<{ id: string; role: string }>(workspacePath(`/memberships/${membershipId}/role`), { role });
  },

  /** Revokes the seat and ends the member's sessions. */
  remove(membershipId: string) {
    return api.del<void>(workspacePath(`/memberships/${membershipId}`));
  },
};
