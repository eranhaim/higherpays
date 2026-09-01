/** Calendar fields of an instant, as seen in one IANA time zone. */
export interface TzParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export const TZ_LIST = [
  'UTC','America/Los_Angeles','America/Denver','America/Chicago','America/New_York',
  'America/Toronto','America/Sao_Paulo','Atlantic/Reykjavik','Europe/London','Europe/Paris',
  'Europe/Berlin','Europe/Madrid','Europe/Athens','Europe/Moscow','Africa/Lagos',
  'Africa/Johannesburg','Asia/Dubai','Asia/Karachi','Asia/Kolkata','Asia/Bangkok',
  'Asia/Singapore','Asia/Hong_Kong','Asia/Shanghai','Asia/Tokyo','Australia/Perth',
  'Australia/Sydney','Pacific/Auckland',
];


export function detectedTZ(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

export function tzParts(ts: number, tz: string): TzParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(
    dtf.formatToParts(new Date(ts)).map(x => [x.type, x.value])
  );
  let hh = +p.hour;
  if (hh === 24) hh = 0;
  return { y: +p.year, mo: +p.month, d: +p.day, h: hh, mi: +p.minute, s: +p.second };
}

function tzOff(ts: number, tz: string): number {
  const p = tzParts(ts, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - ts;
}

export function zonedMs(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  return guess - tzOff(guess, tz);
}

export function startOfDayTZ(ts: number, tz: string): number {
  const p = tzParts(ts, tz);
  return zonedMs(p.y, p.mo, p.d, 0, 0, 0, tz);
}

export function startOfMonthTZ(ts: number, tz: string): number {
  const p = tzParts(ts, tz);
  return zonedMs(p.y, p.mo, 1, 0, 0, 0, tz);
}

export function startOfQuarterTZ(ts: number, tz: string): number {
  const p = tzParts(ts, tz);
  return zonedMs(p.y, Math.floor((p.mo - 1) / 3) * 3 + 1, 1, 0, 0, 0, tz);
}

export function parseDateTZ(str: string | null | undefined, endOfDay: boolean, tz: string): number | null {
  if (!str) return null;
  const a = str.split('-').map(Number);
  return endOfDay
    ? zonedMs(a[0], a[1], a[2], 23, 59, 59, tz)
    : zonedMs(a[0], a[1], a[2], 0, 0, 0, tz);
}

export function tzTimeLabel(ts: number | null | undefined, tz: string): string {
  const p = tzParts(ts == null ? Date.now() : ts, tz);
  return String(p.h).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0');
}

/** `YYYY-MM-DD` for a timestamp in `tz`, matching what `<input type="date">` holds. */
export function toDateInputTZ(ts: number, tz: string): string {
  const p = tzParts(ts, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
