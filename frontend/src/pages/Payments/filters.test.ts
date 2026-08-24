import { describe, it, expect } from 'vitest';
import { filterTransactions, DEFAULT_FILTERS } from './filters';
import type { Transaction } from '../../api/endpoints';

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx1',
    providerTransactionId: 'MP-1001',
    gross: 50,
    platformFee: 5,
    status: 'approved',
    occurredAt: '2026-08-10T12:00:00.000Z',
    creator: 'Ava',
    customer: 'fan_one',
    chatter: 'Sam',
    ...overrides,
  };
}

const rows: Transaction[] = [
  tx({ id: 'a' }),
  tx({ id: 'b', status: 'declined', providerTransactionId: 'MP-1002', customer: 'fan_two' }),
  tx({ id: 'c', status: 'refunded', occurredAt: '2026-07-01T09:00:00.000Z', chatter: 'Lee' }),
];

describe('filterTransactions', () => {
  it('returns everything with default filters', () => {
    expect(filterTransactions(rows, DEFAULT_FILTERS)).toHaveLength(3);
  });

  it('filters by status', () => {
    expect(filterTransactions(rows, { ...DEFAULT_FILTERS, status: 'declined' }).map((t) => t.id)).toEqual(['b']);
  });

  it('filters by date range, inclusive of the whole "to" day', () => {
    const out = filterTransactions(rows, { ...DEFAULT_FILTERS, from: '2026-08-01', to: '2026-08-10' });
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('searches reference, customer, creator and chatter, case-insensitively', () => {
    expect(filterTransactions(rows, { ...DEFAULT_FILTERS, search: 'mp-1002' }).map((t) => t.id)).toEqual(['b']);
    expect(filterTransactions(rows, { ...DEFAULT_FILTERS, search: 'lee' }).map((t) => t.id)).toEqual(['c']);
    expect(filterTransactions(rows, { ...DEFAULT_FILTERS, search: 'ava' })).toHaveLength(3);
  });

  it('ignores null fields when searching', () => {
    const withNulls = [tx({ id: 'n', providerTransactionId: null, customer: null, creator: null, chatter: null })];
    expect(filterTransactions(withNulls, { ...DEFAULT_FILTERS, search: 'x' })).toHaveLength(0);
    expect(filterTransactions(withNulls, DEFAULT_FILTERS)).toHaveLength(1);
  });
});
