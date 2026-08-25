import type { Transaction } from '../../types';
import { isPaid } from '../../api/endpoints';

export interface PaymentsFilters {
  status: '' | 'paid' | 'declined';
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
    if (f.status === 'paid' && !isPaid(t.status)) return false;
    if (f.status === 'declined' && isPaid(t.status)) return false;
    if (fromTs && t.ts < fromTs) return false;
    if (toTs && t.ts > toTs) return false;
    if (q) {
      const hay = `${t.referenceId}${t.clientName}${t.username}${t.creator}${t.chatter}${t.notes}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
