import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { MemberStatus } from './team';

export interface Agent {
  id: string;
  userId: string;
  name: string;
  email: string;
  /** Sign-in status; a suspended agent keeps their record and history. */
  status: MemberStatus;
  country: string | null;
  commissionPct: number;
  accountsAssigned: number;
  accounts: Array<{ id: string; name: string }>;
  createdAt: string;
}

/** Creating an agent creates their login as well. */
export interface CreateAgentInput {
  email: string;
  fullName: string;
  /** Required for a new login; ignored when the email already has one. */
  password?: string;
  country?: string;
  commissionPct?: number;
}

export interface UpdateAgentInput {
  fullName?: string;
  commissionPct?: number;
  country?: string;
}

export const agentsApi = {
  async list(): Promise<Agent[]> {
    const raw = await api.get<{ agents: Agent[] }>(workspacePath('/agents'));
    return raw.agents;
  },

  create: (input: CreateAgentInput) => api.post<Agent>(workspacePath('/agents'), input),

  update: (id: string, input: UpdateAgentInput) => api.patch<Agent>(workspacePath(`/agents/${id}`), input),
};
