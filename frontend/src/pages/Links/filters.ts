import type { PaymentLink, LinkStatus } from '../../api/endpoints';

export interface LinksFilters {
  creator: string;
  status: '' | LinkStatus;
  min: string;
  max: string;
  from: string;
  to: string;
  search: string;
}

export const DEFAULT_FILTERS: LinksFilters = {
  creator: '', status: '', min: '', max: '', from: '', to: '', search: '',
};

export function filterLinks(rows: PaymentLink[], f: LinksFilters): PaymentLink[] {
  const q = f.search.trim().toLowerCase();
  const min = parseFloat(f.min);
  const max = parseFloat(f.max);
  const fromTs = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null;
  const toTs = f.to ? new Date(`${f.to}T23:59:59`).getTime() : null;

  return rows.filter((l) => {
    const amount = l.amount ?? 0;
    const ts = Date.parse(l.createdAt);
    if (f.creator && l.creator !== f.creator) return false;
    if (f.status && l.status !== f.status) return false;
    if (!Number.isNaN(min) && amount < min) return false;
    if (!Number.isNaN(max) && amount > max) return false;
    if (fromTs && ts < fromTs) return false;
    if (toTs && ts > toTs) return false;
    if (q) {
      const hay = [l.referenceId, l.customer, l.chatter].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
