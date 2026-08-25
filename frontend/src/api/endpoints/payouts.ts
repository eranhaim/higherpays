import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { RevenueModel } from './accounts';

/** Mirrors the `txn_status` enum in the database. */
export type TransactionStatus = 'approved' | 'declined' | 'refunded' | 'charged_back';

export interface Transaction {
  id: string;
  providerTransactionId: string | null;
  gross: number;
  platformFee: number;
  status: TransactionStatus;
  occurredAt: string;
  account: string | null;
  customer: string | null;
  agent: string | null;
}

interface RawTransaction {
  id: string;
  provider_transaction_id: string | null;
  gross: number | string;
  platform_fee: number | string;
  status: TransactionStatus;
  occurred_at: string;
  account: string | null;
  customer: string | null;
  agent: string | null;
}

function toNumber(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function normalizeTransaction(t: RawTransaction): Transaction {
  return {
    id: t.id,
    providerTransactionId: t.provider_transaction_id,
    gross: toNumber(t.gross),
    platformFee: toNumber(t.platform_fee),
    status: t.status,
    occurredAt: t.occurred_at,
    account: t.account,
    customer: t.customer,
    agent: t.agent,
  };
}

export const TRANSACTION_STATUS_LABELS: Record<TransactionStatus, string> = {
  approved: 'Paid',
  declined: 'Declined',
  refunded: 'Refunded',
  charged_back: 'Chargeback',
};

/** Money that was returned after a successful sale. */
export function isReversed(status: TransactionStatus): boolean {
  return status === 'refunded' || status === 'charged_back';
}

export interface PayoutBreakdown {
  range: { from: string; to: string };
  perAccount: Array<{ id: string; name: string; model: RevenueModel; salary: number; revenue: number; owed: number }>;
  perAgent: Array<{ id: string; name: string; owed: number; sales: number }>;
  reserve: { pct: number; releaseDays: number; held: number; source: 'settlements' | 'estimated' };
  /** Can the agency pay everyone today? `available` is receipts minus the reserve. */
  cash: { owed: number; received: number; heldInReserve: number; available: number; shortfallIfPaidNow: number };
}

export interface RefundResult {
  ok: true;
  external: boolean;
  providerRefundAvailable: boolean;
  refunded: number;
  currency: string;
  refundFee: number;
  accountAdjustment: number;
  agentAdjustment: number;
  agencyAdjustment: number;
}

export interface RunPayoutInput {
  payeeType: 'account' | 'agent';
  /** Account id or agent membership id. Omit to pay everyone of that type. */
  targetId?: string;
  from?: string;
  to?: string;
}

/** One page of a keyset-paginated list. `nextCursor` is null on the last page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const payoutsApi = {
  async listTransactions(cursor: string | null = null): Promise<Page<Transaction>> {
    const qs = new URLSearchParams({ limit: '50' });
    if (cursor) qs.set('cursor', cursor);
    const raw = await api.get<Page<RawTransaction>>(workspacePath(`/transactions?${qs.toString()}`));
    return { items: raw.items.map(normalizeTransaction), nextCursor: raw.nextCursor };
  },

  getBreakdown(from: string, to: string): Promise<PayoutBreakdown> {
    const qs = new URLSearchParams({ from, to });
    return api.get<PayoutBreakdown>(workspacePath(`/payouts/breakdown?${qs.toString()}`));
  },

  run(input: RunPayoutInput) {
    return api.post<{
      ran: number;
      total: number;
      payouts: Array<{ recipientId: string; amount: number; payoutId: string }>;
    }>(workspacePath('/payouts/run'), input);
  },

  /** Records a refund already issued in the provider dashboard. */
  refund(transactionId: string) {
    return api.post<RefundResult>(workspacePath(`/transactions/${transactionId}/refund`), { external: true });
  },
};
