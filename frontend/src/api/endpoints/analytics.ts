import { api } from '../http';
import { workspacePath } from '../workspacePath';

/** Response from `GET /workspaces/:wid/analytics`. Money is chargeback-adjusted. */
export interface AnalyticsReport {
  range: { from: string; to: string; days: number };
  scope: 'agency' | 'agent' | 'account';
  timeseries: Array<{ d: string; gross: number; net: number }>;
  // The agency-side figures below are omitted for a scoped caller (an agent or
  // an account): how the agency's cut is divided is not theirs to see. Guard on
  // `scope === 'agency'` or on `can('data.view_all')` before rendering them.
  headline: {
    gross: number;
    net: number;
    platformFee?: number;
    /** Only present for platform operators. */
    hpMargin?: number;
    accountPayout?: number;
    agentPayout?: number;
    agencyKeep?: number;
    takeRatePct?: number;
    aov: number;
    paidCount: number;
    uniqueBuyers: number;
  };
  chargebacks: {
    count: number;
    valueReversed: number;
    feeCost: number;
    ratePct: number;
    rateValuePct: number;
    byBearer?: { account: number; agency: number };
  };
  funnel: {
    created: number;
    paid: number;
    failed: number;
    expired: number;
    conversionPct: number;
    declinePct: number;
    expiryPct: number;
    revenuePerLink: number;
  };
  agents: Array<{
    name: string;
    revenue: number;
    agencyProfit: number;
    sales: number;
    conversionPct: number | null;
    aov: number;
  }>;
  accounts: Array<{
    name: string;
    model: 'revshare' | 'salary' | 'ai';
    salary: number;
    revenue: number;
    accountPayout: number;
    agencyProfit: number;
  }>;
  customers: {
    avgLtv: number;
    arpu: number;
    repeatRatePct: number;
    freq: number;
    concentration: { top1: number; top5: number; top10: number };
    segments: Array<{ segment: string; revenue: number }>;
    newVsReturning: { newRev: number; retRev: number };
  };
  /** 7 rows (Sunday first) × 24 hours of gross revenue. */
  heatmap: number[][];
}

export interface AnalyticsQuery {
  /** ISO timestamps. */
  from: string;
  to: string;
  /** Agency roles may scope the report to one agent membership or one account. */
  agentId?: string;
  accountId?: string;
}

export const analyticsApi = {
  report(query: AnalyticsQuery): Promise<AnalyticsReport> {
    const qs = new URLSearchParams({ from: query.from, to: query.to });
    if (query.agentId) qs.set('agentId', query.agentId);
    if (query.accountId) qs.set('accountId', query.accountId);
    return api.get<AnalyticsReport>(workspacePath(`/analytics?${qs.toString()}`));
  },
};
