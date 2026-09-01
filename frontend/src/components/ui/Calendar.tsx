import { useState } from 'react';
import { MONTHS_SHORT, formatDay } from '../../lib/format';
import { useTimezone } from '../../hooks/useTimezone';
import { toDateInputTZ } from '../../business/timezone';
import type { DateRange } from './DateRangePicker';

interface CalendarProps {
  value: DateRange;
  onChange: (r: DateRange) => void;
}

const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** Calendar maths runs in UTC so a DST change cannot shift a day by one. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** Monday-first offset of the 1st, so the grid columns match DOW. */
function leadingBlanks(y: number, m: number): number {
  return (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
}

function monthOf(value: string, fallback: string): { y: number; m: number } {
  const [y, m] = (value || fallback).split('-').map(Number);
  return { y, m: m - 1 };
}

/**
 * A month of days, picking a range: the first click sets the start, the second
 * the end, and a click before the start is read as a correction rather than as
 * an empty range. Empty strings mean "no bound".
 *
 * Ours rather than the browser's date input, which ignores the theme.
 */
export function Calendar({ value, onChange }: CalendarProps) {
  const tz = useTimezone();
  // Read once at mount: the clock is not something render may ask for.
  const [today] = useState(() => toDateInputTZ(Date.now(), tz));
  const [shown, setShown] = useState(() => monthOf(value.from, today));

  const pickDay = (day: string) => {
    if (!value.from || value.to) onChange({ from: day, to: '' });
    else if (day < value.from) onChange({ from: day, to: value.from });
    else onChange({ from: value.from, to: day });
  };

  const step = (by: -1 | 1) => setShown(({ y, m }) => {
    const next = m + by;
    return { y: y + Math.floor(next / 12), m: ((next % 12) + 12) % 12 };
  });

  const days = Array.from({ length: daysInMonth(shown.y, shown.m) }, (_, i) => isoOf(shown.y, shown.m, i + 1));

  return (
    <>
      <div className="cal-head">
        <button type="button" className="cal-nav" aria-label="Previous month" onClick={() => step(-1)}>‹</button>
        <span className="cal-month">{MONTHS_SHORT[shown.m]} {shown.y}</span>
        <button type="button" className="cal-nav" aria-label="Next month" onClick={() => step(1)}>›</button>
      </div>
      <div className="cal-grid" role="grid">
        {DOW.map((d) => <span key={d} className="cal-dow">{d}</span>)}
        {Array.from({ length: leadingBlanks(shown.y, shown.m) }, (_, i) => <span key={`b${i}`} />)}
        {days.map((day) => {
          const isEdge = day === value.from || day === value.to;
          const isInside = Boolean(value.from && value.to && day > value.from && day < value.to);
          return (
            <button
              key={day}
              type="button"
              className={`cal-day${isEdge ? ' sel' : ''}${isInside ? ' in' : ''}${day === today ? ' today' : ''}`}
              aria-label={formatDay(day)}
              aria-pressed={isEdge}
              onClick={() => pickDay(day)}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </>
  );
}
