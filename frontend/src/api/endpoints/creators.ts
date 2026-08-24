import { api } from '../http';
import { workspacePath } from '../workspacePath';

/** Mirrors the `creator_status` enum. New creators start as `onboarding`. */
export type CreatorStatus = 'onboarding' | 'active' | 'paused' | 'archived';
export type RevenueModel = 'revshare' | 'salary' | 'ai';

export const CREATOR_STATUS_LABELS: Record<CreatorStatus, string> = {
  onboarding: 'Onboarding',
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

/** Creators that can still take new payment links. */
export function canTakeLinks(status: CreatorStatus): boolean {
  return status === 'active' || status === 'onboarding';
}

export const REVENUE_MODEL_LABELS: Record<RevenueModel, string> = {
  revshare: 'Rev-share',
  salary: 'Salary',
  ai: 'AI',
};

export interface Creator {
  id: string;
  stageName: string;
  handle: string | null;
  country: string | null;
  status: CreatorStatus;
  revenueSplitPct: number;
  revenueModel: RevenueModel;
  salary: number | null;
  salaryIncreasePct: number | null;
  createdAt: string;
  chattersAssigned: number;
}

interface RawCreator {
  id: string;
  stage_name: string;
  handle: string | null;
  country: string | null;
  status: CreatorStatus;
  revenue_split_pct: number | string;
  revenue_model: RevenueModel;
  salary: number | string | null;
  salary_increase_pct: number | string | null;
  created_at: string;
  chatters_assigned?: number | string;
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

function normalize(c: RawCreator): Creator {
  return {
    id: c.id,
    stageName: c.stage_name,
    handle: c.handle,
    country: c.country,
    status: c.status,
    revenueSplitPct: toNumber(c.revenue_split_pct),
    revenueModel: c.revenue_model,
    salary: toNullableNumber(c.salary),
    salaryIncreasePct: toNullableNumber(c.salary_increase_pct),
    createdAt: c.created_at,
    chattersAssigned: toNumber(c.chatters_assigned),
  };
}

export interface CreateCreatorInput {
  stageName: string;
  handle?: string;
  country?: string;
  revenueSplitPct?: number;
  revenueModel?: RevenueModel;
  salary?: number;
  salaryIncreasePct?: number;
}

export interface UpdateCreatorInput {
  stageName?: string;
  handle?: string;
  status?: CreatorStatus;
  revenueSplitPct?: number;
}

export const creatorsApi = {
  async list(): Promise<Creator[]> {
    const raw = await api.get<{ creators: RawCreator[] }>(workspacePath('/creators'));
    return raw.creators.map(normalize);
  },

  async create(input: CreateCreatorInput): Promise<Creator> {
    const raw = await api.post<RawCreator>(workspacePath('/creators'), input);
    return normalize(raw);
  },

  async update(id: string, input: UpdateCreatorInput): Promise<Creator> {
    const raw = await api.patch<RawCreator>(workspacePath(`/creators/${id}`), input);
    return normalize(raw);
  },

  assignChatter(creatorId: string, membershipId: string) {
    return api.post<{ ok: true }>(workspacePath(`/creators/${creatorId}/assignments`), { membershipId });
  },
};
