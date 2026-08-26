import { api } from '../http';
import { workspacePath } from '../workspacePath';

/** Mirrors ACCOUNT_STATUS in the schema. */
export type AccountStatus = 'active' | 'paused' | 'archived';

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

export interface AccountAgent {
  agentId: string;
  name: string;
  email: string;
}

export interface Account {
  id: string;
  name: string;
  handle: string | null;
  country: string | null;
  status: AccountStatus;
  userId: string;
  ownerName: string;
  ownerEmail: string;
  createdAt: string;
  // The share and the roster are only sent to callers who see the whole
  // workspace (the owner also gets their own share); an agent gets the
  // account without its terms.
  revenueSplitPct?: number;
  agentsAssigned?: number;
  agents?: AccountAgent[];
}

/** Creating an account creates its owner's login as well. */
export interface CreateAccountInput {
  email: string;
  fullName: string;
  /** Required for a new login; ignored when the email already has one. */
  password?: string;
  name: string;
  handle?: string;
  country?: string;
  revenueSplitPct?: number;
}

export interface UpdateAccountInput {
  name?: string;
  handle?: string;
  country?: string;
  status?: AccountStatus;
  revenueSplitPct?: number;
}

export const accountsApi = {
  async list(): Promise<Account[]> {
    const raw = await api.get<{ accounts: Account[] }>(workspacePath('/accounts'));
    return raw.accounts;
  },

  get: (id: string) => api.get<Account>(workspacePath(`/accounts/${id}`)),

  create: (input: CreateAccountInput) => api.post<Account>(workspacePath('/accounts'), input),

  update: (id: string, input: UpdateAccountInput) => api.patch<Account>(workspacePath(`/accounts/${id}`), input),

  assignAgent: (accountId: string, agentId: string) =>
    api.post<{ ok: true }>(workspacePath(`/accounts/${accountId}/agents`), { agentId }),

  unassignAgent: (accountId: string, agentId: string) =>
    api.del<void>(workspacePath(`/accounts/${accountId}/agents/${agentId}`)),
};
