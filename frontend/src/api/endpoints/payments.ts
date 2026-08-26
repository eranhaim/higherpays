import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { Page } from '../types';
import type { LinkType } from './links';

/** Mirrors PAYMENT_STATUS in the schema. */
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded';
export const PAYMENT_STATUSES: PaymentStatus[] = ['pending', 'paid', 'failed', 'cancelled', 'refunded'];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: 'Pending',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

/** Money that was returned after a successful sale. */
export function isReversed(status: PaymentStatus): boolean {
  return status === 'refunded';
}

/** One checkout attempt. A reusable link has many. */
export interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  paymentMethod: string | null;
  providerPaymentId: string | null;
  providerTransactionId: string | null;
  occurredAt: string;
  accountId: string;
  account: string;
  agentId: string | null;
  agent: string | null;
  customerId: string | null;
  customer: string | null;
  customerTelegram: string | null;
  categoryId: string | null;
  category: string | null;
  linkId: string | null;
  linkReference: string | null;
  linkType: LinkType | null;
  /** Paid, but the agent has not yet said who paid and what for. */
  needsDetails: boolean;
  /** Only sent to callers who see the whole workspace. */
  platformFee?: number | null;
}

export interface ListPaymentsQuery {
  status?: string;
  accountId?: string;
  agentId?: string;
  /** YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
  /** Matches provider reference, customer, account, agent or link reference. */
  q?: string;
  needsDetails?: boolean;
}

/** The agent's completion: pick an existing customer or type a new one. */
export interface CompletePaymentInput {
  categoryId: string;
  customerId?: string;
  customer?: { name: string; telegramName?: string };
}

export interface ReversalResult {
  ok: true;
  reversed: number;
  currency: string;
  fee: number;
  accountAdjustment: number;
  agentAdjustment: number;
  agencyAdjustment: number;
}

export const paymentsApi = {
  async list(cursor: string | null = null, filters: ListPaymentsQuery = {}): Promise<Page<Payment>> {
    const qs = new URLSearchParams({ limit: '50' });
    if (cursor) qs.set('cursor', cursor);
    for (const [k, v] of Object.entries(filters)) {
      if (v === undefined || v === '' || v === false) continue;
      if (k === 'from') qs.set('from', `${v}T00:00:00`);
      else if (k === 'to') qs.set('to', `${v}T23:59:59.999`);
      else qs.set(k, String(v));
    }
    return api.get<Page<Payment>>(workspacePath(`/payments?${qs.toString()}`));
  },

  get: (id: string) => api.get<Payment>(workspacePath(`/payments/${id}`)),

  complete: (id: string, input: CompletePaymentInput) =>
    api.patch<Payment>(workspacePath(`/payments/${id}/details`), input),

  /** Records a refund already issued in the provider dashboard. */
  refund: (id: string) => api.post<ReversalResult>(workspacePath(`/payments/${id}/refund`), {}),

  chargeback: (id: string) => api.post<ReversalResult>(workspacePath(`/payments/${id}/chargeback`), {}),
};
