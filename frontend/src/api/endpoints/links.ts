import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { Page } from './payouts';

/** Mirrors the `link_status` enum. `expired` is computed server-side from the link TTL. */
export type LinkStatus = 'created' | 'opened' | 'paid' | 'failed' | 'expired' | 'refunded';
export type PricingMode = 'fixed' | 'open';

export const LINK_STATUSES: LinkStatus[] = ['created', 'opened', 'paid', 'failed', 'expired', 'refunded'];

export const LINK_STATUS_LABELS: Record<LinkStatus, string> = {
  created: 'Created',
  opened: 'Opened',
  paid: 'Paid',
  failed: 'Failed',
  expired: 'Expired',
  refunded: 'Refunded',
};

export interface PaymentLink {
  id: string;
  pricingMode: PricingMode;
  amount: number | null;
  currency: string;
  providerLinkId: string;
  status: LinkStatus;
  referenceId: string;
  createdAt: string;
  paidAt: string | null;
  creator: string | null;
  customer: string | null;
  chatter: string | null;
}

interface RawLink {
  id: string;
  pricing_mode: PricingMode;
  amount: number | string | null;
  currency: string;
  provider_link_id: string;
  status: LinkStatus;
  reference_id: string;
  created_at: string;
  paid_at: string | null;
  creator: string | null;
  customer: string | null;
  chatter: string | null;
}

function toNullableNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

function normalize(l: RawLink): PaymentLink {
  return {
    id: l.id,
    pricingMode: l.pricing_mode,
    amount: toNullableNumber(l.amount),
    currency: l.currency,
    providerLinkId: l.provider_link_id,
    status: l.status,
    referenceId: l.reference_id,
    createdAt: l.created_at,
    paidAt: l.paid_at,
    creator: l.creator,
    customer: l.customer,
    chatter: l.chatter,
  };
}

export interface CreateLinkInput {
  creatorId: string;
  customerId?: string;
  pricingMode?: PricingMode;
  amount?: number;
  currency: string;
  description?: string;
}

export interface CreatedLink extends PaymentLink {
  url: string;
}

export const linksApi = {
  async list(cursor: string | null = null): Promise<Page<PaymentLink>> {
    const qs = new URLSearchParams({ limit: '50' });
    if (cursor) qs.set('cursor', cursor);
    const raw = await api.get<Page<RawLink>>(workspacePath(`/links?${qs.toString()}`));
    return { items: raw.items.map(normalize), nextCursor: raw.nextCursor };
  },

  async create(input: CreateLinkInput): Promise<CreatedLink> {
    const raw = await api.post<RawLink & { url: string }>(workspacePath('/links'), input);
    return { ...normalize(raw), url: raw.url };
  },

  async reconcile(graceMinutes?: number) {
    return api.post<{ checked: number; updated: unknown[]; skipped: unknown[] }>(
      workspacePath('/links/reconcile'),
      graceMinutes != null ? { graceMinutes } : {},
    );
  },
};
