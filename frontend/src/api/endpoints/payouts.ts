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

export const payoutsApi = {
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
};
