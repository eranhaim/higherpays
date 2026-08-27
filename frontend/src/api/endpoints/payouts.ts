import { api } from '../http';
import { workspacePath } from '../workspacePath';

export interface PayoutBreakdown {
  range: { from: string; to: string };
  perAccount: Array<{ id: string; name: string; revenue: number; owed: number }>;
  perAgent: Array<{ id: string; name: string; owed: number; sales: number }>;
  reserve: { pct: number; releaseDays: number; held: number; source: 'settlements' | 'estimated' };
  /** Can the agency pay everyone today? `available` is receipts minus the reserve. */
  cash: { owed: number; received: number; heldInReserve: number; available: number; shortfallIfPaidNow: number };
}

export interface RunPayoutInput {
  payeeType: 'account' | 'agent';
  /** Account id or agent id. Omit to pay everyone of that type. */
  targetId?: string;
  from?: string;
  to?: string;
}

/** One payout that was run: who, how much, for which period. */
export interface PayoutRecord {
  id: string;
  payeeType: 'account' | 'agent';
  payee: string | null;
  periodStart: string;
  periodEnd: string;
  amount: number;
  currency: string;
  status: 'pending' | 'approved' | 'paid' | 'on_hold';
  createdAt: string;
}

export const payoutsApi = {
  getBreakdown(from: string, to: string): Promise<PayoutBreakdown> {
    const qs = new URLSearchParams({ from, to });
    return api.get<PayoutBreakdown>(workspacePath(`/payouts/breakdown?${qs.toString()}`));
  },

  async list(): Promise<PayoutRecord[]> {
    const raw = await api.get<{ payouts: PayoutRecord[] }>(workspacePath('/payouts?limit=200'));
    return raw.payouts;
  },

  run(input: RunPayoutInput) {
    return api.post<{
      ran: number;
      total: number;
      payouts: Array<{ recipientId: string; amount: number; payoutId: string }>;
    }>(workspacePath('/payouts/run'), input);
  },
};
