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
  lastPurchaseAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

/** A row of the customer list: the contact plus their spend in ONE currency. */
export interface CustomerListItem extends Customer {
  /**
   * What they paid in the list's currency. There is no all-currency total: a
   * fan who paid in two currencies owes that money to neither sum.
   */
  totalSpend: number;
}

export interface CustomerSpend {
  currency: string;
  totalSpend: number;
}

export interface CustomerPayment {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  needsDetails: boolean;
  occurredAt: string;
  account: string;
  agent: string | null;
  linkId: string | null;
  linkReference: string | null;
}

export interface CustomerDetail extends Customer {
  /** Every currency this fan paid in, largest first. Never totalled. */
  spendByCurrency: CustomerSpend[];
  payments: CustomerPayment[];
}

/** Mirrors CUSTOMER_SORTS in backend/src/routes/customers.routes.js. */
export type CustomerSort = 'name' | 'spend' | 'last' | 'segment';

export interface ListCustomersQuery {
  /**
   * Which currency the spend column is in. Omitted means the agency's base
   * currency, and the server echoes back what it used.
   */
  currency?: string;
  segment?: CustomerSegment;
  /** Matches name, email, phone or Telegram name. */
  q?: string;
  sort?: CustomerSort;
  dir?: 'asc' | 'desc';
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

export interface UpdateCustomerInput {
  name?: string;
  telegramName?: string;
  email?: string;
  phone?: string;
  segment?: CustomerSegment;
}

export function customersFromResponse(raw: { customers?: CustomerListItem[] }): CustomerListItem[] {
  if (!Array.isArray(raw.customers)) throw new Error('Invalid customers response.');
  return raw.customers;
}

export const customersApi = {
  async list(query: ListCustomersQuery = {}): Promise<CustomerListItem[]> {
    const qs = new URLSearchParams();
    if (query.currency) qs.set('currency', query.currency);
    if (query.segment) qs.set('segment', query.segment);
    if (query.q) qs.set('q', query.q);
    if (query.sort) qs.set('sort', query.sort);
    if (query.dir) qs.set('dir', query.dir);
    if (query.limit != null) qs.set('limit', String(query.limit));
    if (query.offset != null) qs.set('offset', String(query.offset));
    const suffix = qs.toString() ? `/customers?${qs.toString()}` : '/customers';
    const raw = await api.get<{ customers?: CustomerListItem[] }>(workspacePath(suffix));
    return customersFromResponse(raw);
  },

  get: (id: string) => api.get<CustomerDetail>(workspacePath(`/customers/${id}`)),

  create: (input: CreateCustomerInput) => api.post<Customer>(workspacePath('/customers'), input),

  update: (id: string, input: UpdateCustomerInput) => api.patch<Customer>(workspacePath(`/customers/${id}`), input),

  /** Erasure: name and contact details are wiped; their payments stay, anonymised. */
  erase: (id: string) => api.del<void>(workspacePath(`/customers/${id}`)),

  exportCsv(currency?: string) {
    const suffix = currency ? `/customers/export?currency=${currency}` : '/customers/export';
    return api.download(workspacePath(suffix), 'customers.csv');
  },
};
