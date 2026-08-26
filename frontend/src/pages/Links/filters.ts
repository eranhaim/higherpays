import type { LinkStatus, LinkType } from '../../api/endpoints';

/**
 * Link list filters. These are sent to the server — the list is cursor
 * paginated, so filtering in the browser would only ever search the rows
 * already loaded and would report "no matches" for anything older.
 *
 * `min`/`max` are kept as raw text so a cleared box stays cleared rather than
 * collapsing to 0.
 */
export interface LinksFilters {
  accountId: string;
  type: '' | LinkType;
  status: '' | LinkStatus;
  min: string;
  max: string;
  from: string;
  to: string;
  search: string;
}

export const DEFAULT_FILTERS: LinksFilters = {
  accountId: '', type: '', status: '', min: '', max: '', from: '', to: '', search: '',
};

/** True when the user has narrowed the list at all. */
export function hasActiveFilters(f: LinksFilters): boolean {
  return Object.values(f).some((v) => v !== '');
}

/** The one rule the server cannot infer: an inverted range matches nothing. */
export function rangeIsInverted(f: LinksFilters): boolean {
  const min = parseFloat(f.min);
  const max = parseFloat(f.max);
  return !Number.isNaN(min) && !Number.isNaN(max) && max < min;
}
