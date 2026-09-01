/**
 * Date + timezone formatting.
 *
 * The business/timezone module has the low-level TZ arithmetic. This module
 * layers UI-facing formatters on top of it — the split keeps the math
 * side-effect-free and the display side simple.
 */

import { tzParts } from '../../business/timezone';

export const DAY_MS = 86_400_000;

export const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Resolve the timezone to use for display.
 * `mode === 'auto'` returns the browser's local tz; `manual` uses the given
 * override, falling back to UTC when the override is missing.
 */
export function resolveTimezone(mode: 'auto' | 'manual', manual: string | null): string {
  if (mode === 'manual' && manual) return manual;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

/** `13 Aug 2026` for a given ms timestamp in the given IANA tz. */
export function formatDate(ts: number, tz: string): string {
  const p = tzParts(ts, tz);
  return `${p.d} ${MONTHS_SHORT[p.mo - 1]} ${p.y}`;
}

/** `13 Aug 2026` for a yyyy-mm-dd day, which carries no timezone at all. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

/** `17:34` in the given IANA tz. */
export function formatTime(ts: number, tz: string): string {
  const p = tzParts(ts, tz);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

/** Two-piece output for tables that show the date on top and the time under it. */
export function formatDateTime(ts: number, tz: string): { date: string; time: string } {
  const p = tzParts(ts, tz);
  return {
    date: `${p.d} ${MONTHS_SHORT[p.mo - 1]} ${p.y}`,
    time: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`,
  };
}

/** ISO-8601 date string (yyyy-mm-dd) for the given ms timestamp, in UTC. */
export function toIsoDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}
