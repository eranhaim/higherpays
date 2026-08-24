/**
 * Money formatting.
 *
 * The whole app uses EUR today (see `SUPPORTED_CURRENCIES` in the backend
 * `.env.example`), but every call passes the currency explicitly so that
 * adding a second currency later is a matter of threading it through, not
 * a search-and-replace.
 */

const DEFAULT_CURRENCY = 'EUR';

// Fixed locale: the browser's own locale can insert bidi marks (e.g. Hebrew),
// which reorder "€0.00 · 12%" in the ledger. Money must read the same for everyone.
const MONEY_LOCALE = 'en';

/** Formats a number as currency. Never throws — falls back to a plain string. */
export function formatMoney(amount: number, currency: string = DEFAULT_CURRENCY): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(MONEY_LOCALE, { style: 'currency', currency }).format(safe);
  } catch {
    return `${currency} ${safe.toFixed(2)}`;
  }
}

/** Formats a number without currency symbol, always with 2 decimals. */
export function formatDecimal(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return safe.toFixed(2);
}

/** Formats a percentage. `formatPct(0.125)` => "12.5%". */
export function formatPct(fraction: number, digits: number = 1): string {
  const safe = Number.isFinite(fraction) ? fraction : 0;
  return `${(safe * 100).toFixed(digits)}%`;
}

/** Sum of an array. Explicit, faster than `reduce`, and skips the noisy inline lambda. */
export function sum(numbers: readonly number[]): number {
  let total = 0;
  for (const n of numbers) total += n;
  return total;
}
