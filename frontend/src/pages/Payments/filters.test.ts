import { describe, it, expect } from 'vitest';
import { filterTransactions } from './filters';
import type { Transaction } from '../../types';

function tx(partial: Partial<Transaction>): Transaction {
  return {
    id: 't1',
    referenceId: 'ref-1',
    clientName: 'Alice',
    username: '@alice',
    creator: 'Bob',
    chatter: 'Carol',
    amount: 100,
    currency: 'EUR',
    status: 'approved',
    notes: '',
    ts: Date.now(),
    ...partial,
  };
}

describe('filterTransactions', () => {
  it('returns all rows on empty filter', () => {
    const rows = [tx({}), tx({ id: 't2' })];
    expect(filterTransactions(rows, { status: '', from: '', to: '', search: '' })).toHaveLength(2);
  });

  it('keeps only paid rows for status=paid', () => {
    const rows = [tx({ status: 'approved' }), tx({ id: 't2', status: 'declined' })];
    const out = filterTransactions(rows, { status: 'paid', from: '', to: '', search: '' });
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe('approved');
  });

  it('keeps only declined rows for status=declined', () => {
    const rows = [tx({ status: 'approved' }), tx({ id: 't2', status: 'declined' })];
    const out = filterTransactions(rows, { status: 'declined', from: '', to: '', search: '' });
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe('declined');
  });

  it('filters by search across text fields', () => {
    const rows = [
      tx({ clientName: 'Alice', username: '@alice' }),
      tx({ id: 't2', clientName: 'Bob', username: '@bob', creator: 'Dan', chatter: 'Eve' }),
    ];
    const out = filterTransactions(rows, { status: '', from: '', to: '', search: 'ali' });
    expect(out).toHaveLength(1);
    expect(out[0]?.clientName).toBe('Alice');
  });

  it('filters by date range', () => {
    const early = new Date('2026-01-01T12:00:00Z').getTime();
    const late = new Date('2026-06-01T12:00:00Z').getTime();
    const rows = [tx({ id: 't1', ts: early }), tx({ id: 't2', ts: late })];
    const out = filterTransactions(rows, {
      status: '', from: '2026-05-01', to: '2026-12-31', search: '',
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('t2');
  });
});
