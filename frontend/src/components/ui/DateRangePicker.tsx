import { useEffect, useRef, useState } from 'react';
import { DAY_MS, MONTHS_SHORT } from '../../lib/format';
import { useTimezone } from '../../hooks/useTimezone';
import { startOfDayTZ, startOfMonthTZ, toDateInputTZ } from '../../business/timezone';

export interface DateRange {
  from: string;
  to: string;
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (r: DateRange) => void;
}

/** Widest the popover gets. Used to decide which edge to anchor it to. */
const POPOVER_WIDTH = 300;

interface Preset {
  label: string;
  /** Start of the range, or null for "no lower bound". */
  from: (now: number, tz: string) => number | null;
}

// Every period the app offers lives here, so no page invents its own. Bounds
// are computed in the user's timezone — a payout period that starts an hour
// off would settle the wrong entries.
const PRESETS: Preset[] = [
  { label: 'Last 7 days', from: (now, tz) => startOfDayTZ(now - 6 * DAY_MS, tz) },
  { label: 'Last 30 days', from: (now, tz) => startOfDayTZ(now - 29 * DAY_MS, tz) },
  { label: 'This month', from: (now, tz) => startOfMonthTZ(now, tz) },
  { label: 'Last 12 months', from: (now, tz) => startOfDayTZ(now - 365 * DAY_MS, tz) },
];

// Reading the clock lives outside the component: a preset is resolved when the
// user picks it, not on every render.
function rangeForPreset(preset: Preset, tz: string): DateRange {
  const now = Date.now();
  const from = preset.from(now, tz);
  return from === null ? { from: '', to: '' } : { from: toDateInputTZ(from, tz), to: toDateInputTZ(now, tz) };
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

function formatLabel(v: string): string {
  const [y, m, d] = v.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

/**
 * The one date filter in the app. A button showing the current range, opening
 * a popover of presets and a calendar: the first click sets the start, the
 * second the end.
 *
 * Empty strings mean "no bound" — a caller that needs a bounded window fills
 * one in itself rather than the picker refusing to be cleared.
 */
export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tz = useTimezone();
  // Read once at mount and again whenever the popover opens: the clock is not
  // something render may ask for.
  const [today, setToday] = useState(() => toDateInputTZ(Date.now(), tz));
  const [shown, setShown] = useState(() => monthOf(value.from, today));

  // Without this the popover stays open over whatever the user clicks next.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  // Prefixed: on a row of filters an unlabelled "All time" doesn't say what
  // it filters.
  const label = `Date: ${
    !value.from && !value.to ? 'All time' :
    value.from && value.to ? `${formatLabel(value.from)} – ${formatLabel(value.to)}` :
    value.from ? `From ${formatLabel(value.from)}` :
    `Until ${formatLabel(value.to)}`}`;

  const toggle = () => {
    if (!open) {
      // Anchor to whichever edge keeps the popover on screen. A picker sitting
      // at the right of a header would otherwise open off the page.
      const rect = triggerRef.current?.getBoundingClientRect();
      setAlignRight(Boolean(rect) && rect!.left + POPOVER_WIDTH > window.innerWidth);
      const now = toDateInputTZ(Date.now(), tz);
      setToday(now);
      setShown(monthOf(value.from, now));
    }
    setOpen((o) => !o);
  };

  const applyPreset = (preset: Preset) => {
    const range = rangeForPreset(preset, tz);
    onChange(range);
    setShown(monthOf(range.from, today));
  };

  // First click starts a new range, second closes it. A click before the start
  // is read as a correction, not as an empty range.
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
    <div className="range-picker" ref={rootRef}>
      <button type="button" className="btn ghost" aria-expanded={open} onClick={toggle} ref={triggerRef}>
        {label}
      </button>
      {open ? (
        <div className={`rangepop open${alignRight ? ' right' : ''}`}>
          <div className="rp-presets">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" className="btn ghost small" onClick={() => applyPreset(p)}>
                {p.label}
              </button>
            ))}
          </div>

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
                  aria-label={formatLabel(day)}
                  aria-pressed={isEdge}
                  onClick={() => pickDay(day)}
                >
                  {Number(day.slice(8))}
                </button>
              );
            })}
          </div>

          <div className="rp-actions">
            <button type="button" className="btn ghost small" onClick={() => onChange({ from: '', to: '' })}>Clear</button>
            <button type="button" className="btn small" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
