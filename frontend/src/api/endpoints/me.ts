import { api } from '../http';
import { workspacePath } from '../workspacePath';

/**
 * "What am I owed?" for an agent or an account owner. The server answers only
 * for those two roles; anyone who sees the whole workspace uses Payouts.
 */
export interface Earnings {
  range: { from: string; to: string };
  role: 'agent' | 'account_owner';
  period: {
    sales: number;
    gross: number;
    deductions: number;
    afterFees: number;
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
