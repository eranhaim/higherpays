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
  archivedAt: string | null;
  createdAt: string;
  accountId: string;
  account: string;
  agentId: string | null;
  agent: string | null;
  latestProviderAttempt: ProviderAttempt | null;
}

export type LinkEventType =
  | 'created' | 'opened' | 'checkout_initiated' | 'checkout_redirected'
  | 'provider_pending' | 'provider_approved' | 'provider_declined'
  | 'details_completed' | 'cancelled' | 'expired' | 'refunded' | 'chargeback';

export interface LinkEvent {
  type: LinkEventType;
  source: 'higherpays' | 'public_checkout' | 'provider';
  occurredAt: string;
}

export interface PaymentLinkDetail extends PaymentLink {
  events: LinkEvent[];
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
}

export type ProviderAttemptStatus = 'pending' | 'approved' | 'declined';
export const PROVIDER_ATTEMPT_STATUSES: ProviderAttemptStatus[] = ['pending', 'approved', 'declined'];
export const PROVIDER_ATTEMPT_STATUS_LABELS: Record<ProviderAttemptStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  declined: 'Declined',
};

export interface ProviderAttempt {
  status: ProviderAttemptStatus;
  replyCode: string | null;
  replyDescription: string | null;
  transactionId: string | null;
  occurredAt: string;
}

export interface LinksSummary {
  totalLinks: number;
  paidLinks: number;
  successfulPayments: number;
  grossSales: number;
  netAfterFees: number;
  /** Non-overlapping bands: min inclusive, max exclusive. */
  priceBands: Array<{ min: number; max: number | null; count: number }>;
  currency: string;
}

export interface CreateLinkInput {
  accountId: string;
  type: LinkType;
  amount: number;
  currency: string;
  description?: string;
}

/** Server-side filters for the link list. Empty fields are simply not sent. */
/** Mirrors LINK_SORTS in backend/src/routes/links.routes.js. */
export type LinkSort = 'created' | 'amount' | 'status';

/** Everything a reassignment would rewrite. */
export interface ReassignImpact {
  payments: number;
  /** How many of them are in a payout that has already been paid. */
  paidOut: number;
  amount: number;
}

/** Who a link or a payment should belong to from now on. */
export interface ReassignInput {
  accountId?: string;
  /** null clears the agent; omitted leaves it as it is. */
  agentId?: string | null;
}

export interface ListLinksQuery {
  status?: string;
  type?: string;
  min?: string;
  max?: string;
  /** YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
  /** Matches HigherPays Order, MantaPay transaction ID, or agent name. */
  q?: string;
  accountId?: string;
  providerStatus?: ProviderAttemptStatus;
  showArchived?: boolean;
  sort?: LinkSort;
  dir?: 'asc' | 'desc';
}

function filterParams(filters: ListLinksQuery): URLSearchParams {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;
    if (key === 'from') qs.set('from', `${value}T00:00:00`);
    else if (key === 'to') qs.set('to', `${value}T23:59:59.999`);
    else qs.set(key, value);
  }
  return qs;
}

export const linksApi = {
  async list(cursor: string | null = null, filters: ListLinksQuery = {}): Promise<Page<PaymentLink>> {
    const qs = filterParams(filters);
    qs.set('limit', '50');
    if (cursor) qs.set('cursor', cursor);
    return api.get<Page<PaymentLink>>(workspacePath(`/links?${qs.toString()}`));
  },

  summary: (filters: ListLinksQuery = {}) =>
    api.get<LinksSummary>(workspacePath(`/links/summary?${filterParams(filters).toString()}`)),

  create: (input: CreateLinkInput) => api.post<PaymentLink>(workspacePath('/links'), input),

  get: (id: string) => api.get<PaymentLinkDetail>(workspacePath(`/links/${id}`)),

  cancel: (id: string) => api.post<PaymentLink>(workspacePath(`/links/${id}/cancel`), {}),

  updateNote: (id: string, description: string) =>
    api.patch<PaymentLink>(workspacePath(`/links/${id}/note`), { description }),

  archive: (id: string) => api.post<PaymentLink>(workspacePath(`/links/${id}/archive`), {}),

  reactivate: (id: string) => api.post<PaymentLink>(workspacePath(`/links/${id}/reactivate`), {}),

  /** What reassigning this link would move, read before confirming it. */
  impact: (id: string) => api.get<ReassignImpact>(workspacePath(`/links/${id}/impact`)),

  reassign: (id: string, input: ReassignInput) =>
    api.patch<PaymentLink>(workspacePath(`/links/${id}/attribution`), input),
};
