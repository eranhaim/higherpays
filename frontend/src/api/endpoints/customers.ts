import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { PaymentStatus } from './payments';

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

/** A customer belongs to the workspace; they meet an account only through a payment. */
export interface Customer {
  id: string;
  name: string;
  telegramName: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  segment: CustomerSegment;
  totalSpend: number;
  lastPurchaseAt: string | null;
  createdAt: string;
}

export interface CustomerPayment {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  occurredAt: string;
  account: string;
  agent: string | null;
}

export interface CustomerDetail extends Customer {
  payments: CustomerPayment[];
}

export interface ListCustomersQuery {
  segment?: CustomerSegment;
  /** Matches name, email, phone or Telegram name. */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface CreateCustomerInput {
  name: string;
  telegramName?: string;
  email?: string;
  phone?: string;
  segment?: CustomerSegment;
}

export const customersApi = {
  async list(query: ListCustomersQuery = {}): Promise<Customer[]> {
    const qs = new URLSearchParams();
    if (query.segment) qs.set('segment', query.segment);
    if (query.q) qs.set('q', query.q);
    if (query.limit != null) qs.set('limit', String(query.limit));
    if (query.offset != null) qs.set('offset', String(query.offset));
    const suffix = qs.toString() ? `/customers?${qs.toString()}` : '/customers';
    const raw = await api.get<{ customers: Customer[] }>(workspacePath(suffix));
    return raw.customers;
  },

  get: (id: string) => api.get<CustomerDetail>(workspacePath(`/customers/${id}`)),

  create: (input: CreateCustomerInput) => api.post<Customer>(workspacePath('/customers'), input),

  exportCsv() {
    return api.download(workspacePath('/customers/export'), 'customers.csv');
  },
};
