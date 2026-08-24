import { api } from '../http';
import { workspacePath } from '../workspacePath';

/** Response from `GET /workspaces/:wid/analytics`. Money is chargeback-adjusted. */
export interface AnalyticsReport {
  range: { from: string; to: string; days: number };
  scope: 'agency' | 'chatter' | 'creator';
  timeseries: Array<{ d: string; gross: number; net: number }>;
  headline: {
    gross: number;
    net: number;
    platformFee: number;
    /** Only present for platform operators. */
    hpMargin?: number;
    creatorPayout: number;
    chatterPayout: number;
    agencyKeep: number;
    takeRatePct: number;
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
    byBearer: { creator: number; agency: number };
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
  chatters: Array<{
    name: string;
    revenue: number;
    agencyProfit: number;
    sales: number;
    conversionPct: number | null;
    aov: number;
  }>;
  creators: Array<{
    name: string;
    model: 'revshare' | 'salary' | 'ai';
    salary: number;
    revenue: number;
    creatorPayout: number;
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
  /** Agency roles may scope the report to one chatter membership or one creator. */
  chatterId?: string;
  creatorId?: string;
}

export const analyticsApi = {
  report(query: AnalyticsQuery): Promise<AnalyticsReport> {
    const qs = new URLSearchParams({ from: query.from, to: query.to });
    if (query.chatterId) qs.set('chatterId', query.chatterId);
    if (query.creatorId) qs.set('creatorId', query.creatorId);
    return api.get<AnalyticsReport>(workspacePath(`/analytics?${qs.toString()}`));
  },
};
