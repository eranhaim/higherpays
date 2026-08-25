import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { Page } from './payouts';

/** Mirrors the `link_status` enum. `expired` is computed server-side from the link TTL. */
export type LinkStatus = 'created' | 'opened' | 'paid' | 'failed' | 'expired' | 'refunded';
export type PricingMode = 'fixed' | 'open';

export const LINK_STATUSES: LinkStatus[] = ['created', 'opened', 'paid', 'failed', 'expired', 'refunded'];

/** A link still worth sending to the customer: not yet paid, failed or expired. */
export function isShareable(status: LinkStatus): boolean {
  return status === 'created' || status === 'opened';
}

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
  account: string | null;
  customer: string | null;
  agent: string | null;
  /** Null for links created before the URL was stored. */
  url: string | null;
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
  account: string | null;
  customer: string | null;
  agent: string | null;
  checkout_url?: string | null;
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
    account: l.account,
    customer: l.customer,
    agent: l.agent,
    url: l.checkout_url ?? null,
  };
}

export interface CreateLinkInput {
  accountId: string;
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
