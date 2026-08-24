import type { Transaction, TransactionStatus } from '../../api/endpoints';

export interface PaymentsFilters {
  status: '' | TransactionStatus;
  from: string;
  to: string;
  search: string;
}

export const DEFAULT_FILTERS: PaymentsFilters = { status: '', from: '', to: '', search: '' };

export function filterTransactions(rows: Transaction[], f: PaymentsFilters): Transaction[] {
  const q = f.search.trim().toLowerCase();
  const fromTs = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null;
  const toTs = f.to ? new Date(`${f.to}T23:59:59`).getTime() : null;
  return rows.filter((t) => {
    if (f.status && t.status !== f.status) return false;
    const ts = Date.parse(t.occurredAt);
    if (fromTs && ts < fromTs) return false;
    if (toTs && ts > toTs) return false;
    if (q) {
      const hay = [t.providerTransactionId, t.customer, t.creator, t.chatter]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
