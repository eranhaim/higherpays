import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { Page } from '../types';

/** One imported settlement report, reconciled against our own ledger. */
export interface Settlement {
  id: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  settlementDate: string | null;
  paid: boolean;
  volume: number;
  totalFees: number;
  net: number;
  reserve: number;
  breakdown: { mdr: number; volumeFee: number; approvedCost: number; declineCost: number; refundCost: number; chargebackCost: number };
  reconciliation: {
    reported: { volume: number; sales: number; declined: number; refunds: number; chargebacks: number; fees: number };
    ours: { volume: number; sales: number; declined: number; refunds: number; chargebacks: number; fees: number };
    variance: { volume: number; sales: number; declined: number; fees: number };
    matched: boolean;
  };
}

export interface ReserveSchedule {
  reservePct: number;
  releaseDays: number;
  byCurrency: Array<{
    currency: string;
    held: number;
    released: number;
    upcoming: Array<{ releaseOn: string; amount: number }>;
  }>;
}

export interface ImportResult {
  imported: number;
  skipped: Array<{ currency: string; rows: number }>;
}

export const settlementsApi = {
  list(cursor: string | null = null): Promise<Page<Settlement>> {
    const qs = new URLSearchParams({ limit: '50' });
    if (cursor) qs.set('cursor', cursor);
    return api.get<Page<Settlement>>(workspacePath(`/settlements?${qs.toString()}`));
  },

  reserve: () => api.get<ReserveSchedule>(workspacePath('/settlements/reserve')),

  /** The provider's XLSX, sent inline. */
  import: (filename: string, contentBase64: string) =>
    api.post<ImportResult>(workspacePath('/settlements/import'), { filename, contentBase64 }),
};
