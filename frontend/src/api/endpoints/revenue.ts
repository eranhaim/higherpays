import { api } from '../http';
import { workspacePath } from '../workspacePath';

/**
 * The workspace default split: what a new account and a new agent start on.
 * The ledger reads each account's and agent's own rate, so changing this
 * never re-prices anyone already set up.
 */
export interface RevenueRule {
  accountSplitPct: number;
  agencySplitPct: number;
  agentPct: number;
  effectiveFrom: string | null;
}

export const revenueApi = {
  get: () => api.get<{ rule: RevenueRule; blendedRatePct: number }>(workspacePath('/revenue')),

  set: (input: { accountSplitPct: number; agentPct: number }) =>
    api.put<{ rule: RevenueRule }>(workspacePath('/revenue'), input),
};
