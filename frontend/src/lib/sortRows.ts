import type { SortState } from '../components/ui';

/** What a column sorts on, per sort key. Null sorts last in both directions. */
export type SortValues<T> = Record<string, (row: T) => string | number | null>;

/**
 * Sorts a list the page already holds in full. Only for lists the server
 * returns whole — a paginated list has to be sorted by the server, or the
 * order would only ever describe the rows already loaded.
 */
export function sortRows<T>(rows: T[], sort: SortState, values: SortValues<T>): T[] {
  const valueOf = values[sort.key];
  if (!valueOf) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    if (x === null || x === '') return y === null || y === '' ? 0 : 1;
    if (y === null || y === '') return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}
