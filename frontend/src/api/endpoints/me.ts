import { api } from '../http';
import { workspacePath } from '../workspacePath';

/**
 * "What am I owed?" for an agent or an account owner. The server answers only
 * for those two roles; anyone who sees the whole workspace uses Payouts.
 *
 * Net revenue is the only revenue figure here. Gross and the fee total are
 * deliberately absent — either one beside net gives away the platform fee.
 */
export interface Earnings {
  range: { from: string; to: string };
  role: 'agent' | 'account_owner';
  /** Null for an agent, who is always paid a commission. */
  payModel: 'share' | 'salary' | null;
  /** Only set for a salaried creator: what they are owed each payout period. */
  salaryAmount: number | null;
  period: {
    sales: number;
    /** Revenue after all fees — the figure the payout rate is applied to. */
    netRevenue: number;
    /** Zero for a salaried creator: the ledger pays them no share of a sale. */
    yourRatePct: number;
    earned: number;
  };
  balance: { owed: number; paidToDate: number };
}

export const meApi = {
  earnings(from: string, to: string): Promise<Earnings> {
    const qs = new URLSearchParams({ from, to });
    return api.get<Earnings>(workspacePath(`/me/earnings?${qs.toString()}`));
  },
};
