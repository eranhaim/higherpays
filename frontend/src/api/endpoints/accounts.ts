import { api } from '../http';
import { workspacePath } from '../workspacePath';

/** Mirrors the `account_status` enum. New accounts start as `onboarding`. */
export type AccountStatus = 'onboarding' | 'active' | 'paused' | 'archived';
export type RevenueModel = 'revshare' | 'salary' | 'ai';

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  onboarding: 'Onboarding',
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

/** Accounts that can still take new payment links. */
export function canTakeLinks(status: AccountStatus): boolean {
  return status === 'active' || status === 'onboarding';
}

export const REVENUE_MODEL_LABELS: Record<RevenueModel, string> = {
  revshare: 'Rev-share',
  salary: 'Salary',
  ai: 'AI',
};

export interface Account {
  id: string;
  stageName: string;
  handle: string | null;
  country: string | null;
  status: AccountStatus;
  createdAt: string;
  // The pay deal and the assignment count are only sent to callers who see the
  // whole workspace; an agent gets the account without its terms.
  revenueSplitPct?: number;
  revenueModel?: RevenueModel;
  salary?: number | null;
  salaryIncreasePct?: number | null;
  agentsAssigned?: number;
}

interface RawAccount {
  id: string;
  stage_name: string;
  handle: string | null;
  country: string | null;
  status: AccountStatus;
  revenue_split_pct: number | string;
  revenue_model: RevenueModel;
  salary: number | string | null;
  salary_increase_pct: number | string | null;
  created_at: string;
  agents_assigned?: number | string;
}

function toNumber(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function toNullableNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

// A withheld field must stay undefined, not become 0. The server omits the pay
// deal and the assignment count for scoped callers; coercing those to a number
// would show an agent a confident "Agents assigned 0" and a 0% split.
function normalize(a: RawAccount): Account {
  return {
    id: a.id,
    stageName: a.stage_name,
    handle: a.handle,
    country: a.country,
    status: a.status,
    createdAt: a.created_at,
    ...(a.revenue_split_pct !== undefined ? { revenueSplitPct: toNumber(a.revenue_split_pct) } : {}),
    ...(a.revenue_model !== undefined ? { revenueModel: a.revenue_model } : {}),
    ...(a.salary !== undefined ? { salary: toNullableNumber(a.salary) } : {}),
    ...(a.salary_increase_pct !== undefined ? { salaryIncreasePct: toNullableNumber(a.salary_increase_pct) } : {}),
    ...(a.agents_assigned !== undefined ? { agentsAssigned: toNumber(a.agents_assigned) } : {}),
  };
}

export interface CreateAccountInput {
  stageName: string;
  handle?: string;
  country?: string;
  revenueSplitPct?: number;
  revenueModel?: RevenueModel;
  salary?: number;
  salaryIncreasePct?: number;
}

export interface UpdateAccountInput {
  stageName?: string;
  handle?: string;
  status?: AccountStatus;
  revenueSplitPct?: number;
}

export const accountsApi = {
  async list(): Promise<Account[]> {
    const raw = await api.get<{ accounts: RawAccount[] }>(workspacePath('/accounts'));
    return raw.accounts.map(normalize);
  },

  async create(input: CreateAccountInput): Promise<Account> {
    const raw = await api.post<RawAccount>(workspacePath('/accounts'), input);
    return normalize(raw);
  },

  async update(id: string, input: UpdateAccountInput): Promise<Account> {
    const raw = await api.patch<RawAccount>(workspacePath(`/accounts/${id}`), input);
    return normalize(raw);
  },

  assignAgent(accountId: string, membershipId: string) {
    return api.post<{ ok: true }>(workspacePath(`/accounts/${accountId}/assignments`), { membershipId });
  },
};
