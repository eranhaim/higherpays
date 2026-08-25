import { api } from '../http';
import { workspacePath } from '../workspacePath';

export type CustomerSegment = 'new' | 'regular' | 'high_value' | 'vip' | 'inactive' | 'at_risk';

export const CUSTOMER_SEGMENTS: CustomerSegment[] = ['new', 'regular', 'high_value', 'vip', 'inactive', 'at_risk'];

export const CUSTOMER_SEGMENT_LABELS: Record<CustomerSegment, string> = {
  new: 'New',
  regular: 'Regular',
  high_value: 'High value',
  vip: 'VIP',
  inactive: 'Inactive',
  at_risk: 'At risk',
};

export interface Customer {
  id: string;
  alias: string;
  email: string | null;
  accountId: string | null;
  segment: CustomerSegment;
  totalSpend: number;
  lastPurchaseAt: string | null;
  createdAt: string;
}

interface RawCustomer {
  id: string;
  alias: string;
  email: string | null;
  account_id: string | null;
  segment: CustomerSegment;
  total_spend: number | string | null;
  last_purchase_at: string | null;
  created_at: string;
}

function toNumber(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function normalize(c: RawCustomer): Customer {
  return {
    id: c.id,
    alias: c.alias,
    email: c.email,
    accountId: c.account_id,
    segment: c.segment,
    totalSpend: toNumber(c.total_spend),
    lastPurchaseAt: c.last_purchase_at,
    createdAt: c.created_at,
  };
}

export interface ListCustomersQuery {
  segment?: CustomerSegment;
  q?: string;
  accountId?: string;
  limit?: number;
  offset?: number;
}

export interface CreateCustomerInput {
  alias: string;
  email?: string;
  accountId?: string;
  segment?: CustomerSegment;
}

export const customersApi = {
  async list(query: ListCustomersQuery = {}): Promise<Customer[]> {
    const qs = new URLSearchParams();
    if (query.segment) qs.set('segment', query.segment);
    if (query.q) qs.set('q', query.q);
    if (query.accountId) qs.set('accountId', query.accountId);
    if (query.limit != null) qs.set('limit', String(query.limit));
    if (query.offset != null) qs.set('offset', String(query.offset));
    const suffix = qs.toString() ? `/customers?${qs.toString()}` : '/customers';
    const raw = await api.get<{ customers: RawCustomer[] }>(workspacePath(suffix));
    return raw.customers.map(normalize);
  },

  async create(input: CreateCustomerInput): Promise<Customer> {
    const raw = await api.post<RawCustomer>(workspacePath('/customers'), input);
    return normalize(raw);
  },

  exportCsv() {
    return api.download(workspacePath('/customers/export'), 'customers.csv');
  },
};
