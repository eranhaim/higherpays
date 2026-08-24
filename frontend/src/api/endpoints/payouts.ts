import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { RevenueModel } from './creators';

/** Mirrors the `txn_status` enum in the database. */
export type TransactionStatus = 'approved' | 'declined' | 'refunded' | 'charged_back';

export interface Transaction {
  id: string;
  providerTransactionId: string | null;
  gross: number;
  platformFee: number;
  status: TransactionStatus;
  occurredAt: string;
  creator: string | null;
  customer: string | null;
  chatter: string | null;
}

interface RawTransaction {
  id: string;
  provider_transaction_id: string | null;
  gross: number | string;
  platform_fee: number | string;
  status: TransactionStatus;
  occurred_at: string;
  creator: string | null;
  customer: string | null;
  chatter: string | null;
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
    creator: t.creator,
    customer: t.customer,
    chatter: t.chatter,
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
  perCreator: Array<{ id: string; name: string; model: RevenueModel; salary: number; revenue: number; owed: number }>;
  perChatter: Array<{ id: string; name: string; owed: number; sales: number }>;
  reserve: { pct: number; releaseDays: number; held: number; source: 'settlements' | 'estimated' };
  cash: { owed: number; heldInReserve: number; shortfallIfPaidNow: number };
}

export interface RefundResult {
  ok: true;
  external: boolean;
  providerRefundAvailable: boolean;
  refunded: number;
  currency: string;
  refundFee: number;
  creatorAdjustment: number;
  chatterAdjustment: number;
  agencyAdjustment: number;
}

export interface RunPayoutInput {
  payeeType: 'creator' | 'chatter';
  /** Creator id or chatter membership id. Omit to pay everyone of that type. */
  targetId?: string;
  from?: string;
  to?: string;
}

export const payoutsApi = {
  async listTransactions(): Promise<Transaction[]> {
    const raw = await api.get<{ transactions: RawTransaction[] }>(workspacePath('/transactions'));
    return raw.transactions.map(normalizeTransaction);
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
