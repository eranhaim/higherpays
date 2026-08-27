import { useEffect, useId, useRef, useState } from 'react';
import { DAY_MS, MONTHS_SHORT } from '../../lib/format';
import { useTimezone } from '../../hooks/useTimezone';
import { startOfDayTZ, startOfMonthTZ, startOfWeekTZ, toDateInputTZ } from '../../business/timezone';

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
  { label: 'Last 90 days', from: (now, tz) => startOfDayTZ(now - 89 * DAY_MS, tz) },
  { label: 'This week', from: (now, tz) => startOfWeekTZ(now, tz) },
  { label: 'This month', from: (now, tz) => startOfMonthTZ(now, tz) },
  { label: 'Last 12 months', from: (now, tz) => startOfDayTZ(now - 365 * DAY_MS, tz) },
  { label: 'All time', from: () => null },
];

// Reading the clock lives outside the component: a preset is resolved when the
// user picks it, not on every render.
function rangeForPreset(preset: Preset, tz: string): DateRange {
  const now = Date.now();
  const from = preset.from(now, tz);
  return from === null ? { from: '', to: '' } : { from: toDateInputTZ(from, tz), to: toDateInputTZ(now, tz) };
}

function formatLabel(v: string): string {
  const d = new Date(`${v}T00:00:00`);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * The one date filter in the app. A button showing the current range, opening
 * a popover of presets plus two inputs for an exact window.
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
  const id = useId();

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

  const label =
    !value.from && !value.to ? 'All time' :
    value.from && value.to ? `${formatLabel(value.from)} – ${formatLabel(value.to)}` :
    value.from ? `From ${formatLabel(value.from)}` :
    `Until ${formatLabel(value.to)}`;

  const toggle = () => {
    if (!open) {
      // Anchor to whichever edge keeps the popover on screen. A picker sitting
      // at the right of a header would otherwise open off the page.
      const rect = triggerRef.current?.getBoundingClientRect();
      setAlignRight(Boolean(rect) && rect!.left + POPOVER_WIDTH > window.innerWidth);
    }
    setOpen((o) => !o);
  };

  const applyPreset = (preset: Preset) => {
    onChange(rangeForPreset(preset, tz));
    setOpen(false);
  };

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
          <div className="rp-row">
            <label htmlFor={`${id}-from`}>From</label>
            <input
              id={`${id}-from`}
              type="date"
              value={value.from}
              max={value.to || undefined}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
            />
          </div>
          <div className="rp-row">
            <label htmlFor={`${id}-to`}>To</label>
            <input
              id={`${id}-to`}
              type="date"
              value={value.to}
              min={value.from || undefined}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
            />
          </div>
          <div className="rp-actions">
            <button type="button" className="btn" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
