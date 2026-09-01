import { useEffect, useRef, useState } from 'react';
import { formatDay } from '../../lib/format';
import { Calendar } from './Calendar';

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

/**
 * The date filter as a standalone control: a button showing the current range,
 * opening the calendar. Inside a column header the calendar is shown directly
 * — the header's own popover is the disclosure there.
 *
 * Empty strings mean "no bound" — a caller that needs a bounded window fills
 * one in itself rather than the picker refusing to be cleared.
 */
export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  // Prefixed: on a row of filters a bare date doesn't say what it filters.
  const label = `Date: ${
    !value.from && !value.to ? 'No filter' :
    value.from && value.to ? `${formatDay(value.from)} – ${formatDay(value.to)}` :
    value.from ? `From ${formatDay(value.from)}` :
    `Until ${formatDay(value.to)}`}`;

  const toggle = () => {
    if (!open) {
      // Anchor to whichever edge keeps the popover on screen. A picker sitting
      // at the right of a header would otherwise open off the page.
      const rect = triggerRef.current?.getBoundingClientRect();
      setAlignRight(Boolean(rect) && rect!.left + POPOVER_WIDTH > window.innerWidth);
    }
    setOpen((o) => !o);
  };

  return (
    <div className="range-picker" ref={rootRef}>
      <button type="button" className="btn ghost" aria-expanded={open} onClick={toggle} ref={triggerRef}>
        {label}
      </button>
      {open ? (
        <div className={`rangepop open${alignRight ? ' right' : ''}`}>
          <Calendar value={value} onChange={onChange} />
          <div className="rp-actions">
            <button type="button" className="btn ghost small" onClick={() => onChange({ from: '', to: '' })}>Clear</button>
            <button type="button" className="btn small" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
