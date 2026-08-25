import { api } from '../http';
import { workspacePath } from '../workspacePath';

/**
 * Transaction status vocabulary. This matches the DB `txn_status` enum
 * exactly — do not add values here unless you also add the migration.
 * The DB is the single source of truth.
 */
export type TransactionStatus = 'approved' | 'declined' | 'refunded' | 'charged_back';

/** True when a transaction represents money currently in our account. */
export const isPaid = (s: TransactionStatus): boolean => s === 'approved';

/** True when a transaction has been refunded (funds returned to payer). */
export const isRefunded = (s: TransactionStatus): boolean =>
  s === 'refunded' || s === 'charged_back';

/** UI label + tone for a given status; single place, no drift. */
export function displayStatus(s: TransactionStatus): { label: string; tone: 'ok' | 'no' | 'muted' } {
  switch (s) {
    case 'approved':     return { label: 'Paid',       tone: 'ok'    };
    case 'declined':     return { label: 'Declined',   tone: 'no'    };
    case 'refunded':     return { label: 'Refunded',   tone: 'muted' };
    case 'charged_back': return { label: 'Chargeback', tone: 'no'    };
  }
}

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

function normalizeTx(t: RawTransaction): Transaction {
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

export interface PayoutBreakdown {
  range: { from: string; to: string };
  perCreator: Array<{ name: string; model: string; salary: number; revenue: number; owed: number }>;
  perChatter: Array<{ name: string; owed: number; sales: number }>;
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

export const payoutsApi = {
  async listTransactions(): Promise<Transaction[]> {
    const raw = await api.get<{ transactions: RawTransaction[] }>(
      workspacePath('/transactions'),
    );
    return raw.transactions.map(normalizeTx);
  },

  async getBreakdown(from?: string, to?: string): Promise<PayoutBreakdown> {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const suffix = qs.toString() ? `/payouts/breakdown?${qs.toString()}` : '/payouts/breakdown';
    return api.get<PayoutBreakdown>(workspacePath(suffix));
  },

  async run(input: {
    payeeType: 'creator' | 'chatter';
    targetId?: string;
    from?: string;
    to?: string;
  }) {
    return api.post<{
      ran: number;
      total: number;
      payouts: Array<{ recipientId: string; amount: number; payoutId: string }>;
    }>(workspacePath('/payouts/run'), input);
  },

  async refund(transactionId: string, input: { external?: boolean; amount?: number } = {}) {
    return api.post<RefundResult>(
      workspacePath(`/transactions/${transactionId}/refund`),
      input,
    );
  },
};
