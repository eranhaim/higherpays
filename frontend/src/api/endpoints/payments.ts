import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { Page } from '../types';
import type { WorkspaceLabels } from '../types';
import type { LinkType, ReassignImpact, ReassignInput } from './links';

/** Mirrors PAYMENT_STATUS in the schema. */
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';
export const PAYMENT_STATUSES: PaymentStatus[] = ['pending', 'paid', 'failed', 'refunded'];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: 'Pending',
  paid: 'Paid',
  failed: 'Failed',
  refunded: 'Refunded',
};

/** Money that was returned after a successful sale. */
export function isReversed(status: PaymentStatus): boolean {
  return status === 'refunded';
}

/** One checkout attempt. A reusable link has many. */
export interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  paymentMethod: string | null;
  providerPaymentId: string | null;
  providerTransactionId: string | null;
  occurredAt: string;
  accountId: string;
  account: string;
  agentId: string | null;
  agent: string | null;
  customerId: string | null;
  customer: string | null;
  customerTelegram: string | null;
  categoryId: string | null;
  category: string | null;
  linkId: string | null;
  linkReference: string | null;
  linkType: LinkType | null;
  /** Paid, but the agent has not yet said who paid and what for. */
  needsDetails: boolean;
  /** Only sent to callers who see the whole workspace. */
  platformFee?: number | null;
}

export interface PaymentFlowParty {
  name?: string | null;
  amount: number;
  percentage: number;
  base: number;
}

export interface PaymentFlowRate {
  percentage: number;
  base: number;
}

export interface PaymentFlow {
  paymentId: string;
  status: PaymentStatus;
  currency: string;
  linkReference: string | null;
  providerTransactionId: string | null;
  customerTotal: number;
  saleAmount: number;
  checkoutFee: number;
  settled: boolean;
  fees: {
    mdr: number;
    fixed: number;
    settlement: number;
    provider: number;
    providerSource: 'estimated' | 'actual';
    platform: number;
    higherPaysMargin: number;
  };
  rates: {
    mdr: PaymentFlowRate;
    settlement: PaymentFlowRate | null;
    higherPaysMargin: PaymentFlowRate;
  };
  distributable: number;
  distribution: {
    account: PaymentFlowParty;
    agent: PaymentFlowParty;
    agency: PaymentFlowParty;
  };
}

export interface PaymentsSummary {
  grossContent: number;
  /** Only sent to callers with workspace-wide data access. */
  platformFees?: number;
  /** Only sent to callers with workspace-wide data access. */
  netProfit?: number;
  approvedPayments: number;
  attempts: number;
  approvalRate: number;
  detailsNeeded: number;
  refundedCount: number;
  refundedAmount: number;
  /** Only sent to HigherPays platform administrators. */
  checkoutFeeRevenue?: number;
  currency: string;
}

export const PROVIDER_FEE_SOURCE_LABELS: Record<PaymentFlow['fees']['providerSource'], string> = {
  estimated: 'Estimated',
  actual: 'Actual',
};

/** Mirrors PAYMENT_SORTS in backend/src/routes/payments.routes.js. */
export type PaymentSort = 'date' | 'amount' | 'status';

export interface ListPaymentsQuery {
  status?: string;
  accountId?: string;
  agentId?: string;
  /** YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
  /** Matches HigherPays Order, MantaPay transaction ID, customer, account, or agent. */
  q?: string;
  needsDetails?: boolean;
  sort?: PaymentSort;
  dir?: 'asc' | 'desc';
}

/** The agent's completion: pick an existing customer or type a new one. */
/** Mirrors EXPORT_COLUMNS in backend/src/routes/payments.routes.js. */
export interface ExportColumn {
  key: string;
  label: string;
  /** Only offered to someone who sees the whole workspace. */
  feesOnly?: boolean;
}

export function getPaymentExportColumns(labels: WorkspaceLabels): ExportColumn[] {
  return [
  { key: 'date', label: 'Date' },
  { key: 'reference', label: 'HigherPays Order' },
  { key: 'providerTransaction', label: 'MantaPay Transaction ID' },
  { key: 'status', label: 'Status' },
  { key: 'gross', label: 'Gross Revenue' },
  { key: 'fee', label: 'Platform Fee', feesOnly: true },
  { key: 'net', label: 'Net Revenue', feesOnly: true },
  { key: 'customer', label: 'Customer' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'creator', label: labels.account },
  { key: 'agent', label: labels.agent },
  { key: 'category', label: 'Category' },
  ];
}

export interface ExportOptions {
  columns?: string[];
  /** Caps the rows written; omitted means everything that matches. */
  limit?: number;
}

export interface CompletePaymentInput {
  categoryId: string;
  customerId?: string;
  customer?: { name: string; telegramName?: string };
}

export interface ReversalResult {
  ok: true;
  reversed: number;
  currency: string;
  fee: number;
  accountAdjustment: number;
  agentAdjustment: number;
  agencyAdjustment: number;
}

function filterParams(filters: ListPaymentsQuery): URLSearchParams {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === '' || v === false) continue;
    // The date inputs give a day; the server compares timestamps, so the
    // upper bound has to cover the whole of that day.
    if (k === 'from') qs.set('from', `${v}T00:00:00`);
    else if (k === 'to') qs.set('to', `${v}T23:59:59.999`);
    else qs.set(k, String(v));
  }
  return qs;
}

export const paymentsApi = {
  list(cursor: string | null = null, filters: ListPaymentsQuery = {}): Promise<Page<Payment>> {
    const qs = filterParams(filters);
    qs.set('limit', '50');
    if (cursor) qs.set('cursor', cursor);
    return api.get<Page<Payment>>(workspacePath(`/payments?${qs.toString()}`));
  },

  summary: (filters: ListPaymentsQuery = {}) =>
    api.get<PaymentsSummary>(workspacePath(`/payments/summary?${filterParams(filters).toString()}`)),

  /** The same filtered list, as a CSV download. */
  exportCsv(filters: ListPaymentsQuery = {}, options: ExportOptions = {}) {
    const qs = filterParams(filters);
    if (options.columns?.length) qs.set('columns', options.columns.join(','));
    if (options.limit) qs.set('limit', String(options.limit));
    return api.download(workspacePath(`/payments/export?${qs.toString()}`), 'payments.csv');
  },

  get: (id: string) => api.get<Payment>(workspacePath(`/payments/${id}`)),

  complete: (id: string, input: CompletePaymentInput) =>
    api.patch<Payment>(workspacePath(`/payments/${id}/details`), input),

  /** Records a refund already issued in the provider dashboard. */
  refund: (id: string) => api.post<ReversalResult>(workspacePath(`/payments/${id}/refund`), {}),

  chargeback: (id: string) => api.post<ReversalResult>(workspacePath(`/payments/${id}/chargeback`), {}),

  /** What reassigning this payment would move, read before confirming it. */
  impact: (id: string) => api.get<ReassignImpact>(workspacePath(`/payments/${id}/impact`)),

  /** The platform-only waterfall explaining how a payment was distributed. */
  flow: (id: string) => api.get<PaymentFlow>(workspacePath(`/payments/${id}/flow`)),

  reassign: (id: string, input: ReassignInput) =>
    api.patch<Payment>(workspacePath(`/payments/${id}/attribution`), input),
};
