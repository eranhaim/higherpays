import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { Page } from '../types';

/**
 * single_use dies on the first payment, or 24h after creation if nobody pays.
 * reusable stays open through any number of payments until someone cancels it.
 */
export type LinkType = 'single_use' | 'reusable';
export const LINK_TYPES: LinkType[] = ['single_use', 'reusable'];
export const LINK_TYPE_LABELS: Record<LinkType, string> = {
  single_use: 'Single use',
  reusable: 'Reusable',
};

/**
 *   active     payable
 *   pending    paid, waiting for the agent to complete the payment details
 *   done       paid and completed
 *   expired    a single-use link went unpaid past its deadline
 *   cancelled  closed by hand
 *   refunded   a paid link was later reversed
 */
export type LinkStatus = 'active' | 'pending' | 'done' | 'expired' | 'cancelled' | 'refunded';
export const LINK_STATUSES: LinkStatus[] = ['active', 'pending', 'done', 'expired', 'cancelled', 'refunded'];

export const LINK_STATUS_LABELS: Record<LinkStatus, string> = {
  active: 'Active',
  pending: 'Paid — details needed',
  done: 'Done',
  expired: 'Expired',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

/** A link still worth sending to the customer. */
export function isShareable(status: LinkStatus): boolean {
  return status === 'active';
}

export interface PaymentLink {
  id: string;
  type: LinkType;
  amount: number | null;
  currency: string;
  status: LinkStatus;
  referenceId: string;
  description: string | null;
  checkoutUrl: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
  accountId: string;
  account: string;
  agentId: string | null;
  agent: string | null;
}

export interface CreateLinkInput {
  accountId: string;
  type: LinkType;
  amount: number;
  currency: string;
  description?: string;
}

/** Server-side filters for the link list. Empty fields are simply not sent. */
export interface ListLinksQuery {
  status?: string;
  type?: string;
  min?: string;
  max?: string;
  /** YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
  /** Matches reference, customer name or agent name. */
  q?: string;
  accountId?: string;
}

export const linksApi = {
  async list(cursor: string | null = null, filters: ListLinksQuery = {}): Promise<Page<PaymentLink>> {
    const qs = new URLSearchParams({ limit: '50' });
    if (cursor) qs.set('cursor', cursor);
    // The date inputs give a day; the server compares timestamps, so the upper
    // bound has to cover the whole of that day.
    for (const [k, v] of Object.entries(filters)) {
      if (!v) continue;
      if (k === 'from') qs.set('from', `${v}T00:00:00`);
      else if (k === 'to') qs.set('to', `${v}T23:59:59.999`);
      else qs.set(k, v);
    }
    return api.get<Page<PaymentLink>>(workspacePath(`/links?${qs.toString()}`));
  },

  create: (input: CreateLinkInput) => api.post<PaymentLink>(workspacePath('/links'), input),

  cancel: (id: string) => api.post<PaymentLink>(workspacePath(`/links/${id}/cancel`), {}),

  reconcile(graceMinutes?: number) {
    return api.post<{ checked: number; updated: unknown[]; skipped: unknown[] }>(
      workspacePath('/links/reconcile'), graceMinutes != null ? { graceMinutes } : {});
  },
};
