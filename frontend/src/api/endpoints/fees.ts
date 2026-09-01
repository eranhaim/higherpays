import { api } from '../http';
import { workspacePath } from '../workspacePath';

export interface FeesSummary {
  range: { from: string; to: string };
  sales: number;
  gross: number;
  providerFees: {
    mdr: number;
    fixed: number;
    settlement: number;
    reversalFees: number;
    total: number;
    percentOfGross: number;
  };
  platformFees: {
    margin: number;
    total: number;
    percentOfGross: number;
  };
  totalDeducted: number;
  effectiveRatePct: number;
  distributable: number;
  splits: { account: number; agent: number; agency: number };
  rateCard: {
    feeModel: string;
    mdrPct: number;
    settlementPct: number;
    fixedFee: number;
    marginPct: number;
    itemised: boolean;
  };
}

export const feesApi = {
  async summary(from?: string, to?: string): Promise<FeesSummary> {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const suffix = qs.toString() ? `/fees?${qs.toString()}` : '/fees';
    return api.get<FeesSummary>(workspacePath(suffix));
  },
};
