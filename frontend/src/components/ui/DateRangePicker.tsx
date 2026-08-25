import { useId, useState } from 'react';
import { MONTHS_SHORT } from '../../lib/format';

export interface DateRange {
  from: string;
  to: string;
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (r: DateRange) => void;
}

function formatLabel(v: string): string {
  const d = new Date(`${v}T00:00:00`);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Two-input date-range popover triggered from a button. Empty strings mean
 * "no bound" — the caller can render "All time" in that case.
 */
export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const label =
    !value.from && !value.to ? 'All time' :
    value.from && value.to ? `${formatLabel(value.from)} – ${formatLabel(value.to)}` :
    value.from ? `From ${formatLabel(value.from)}` :
    `Until ${formatLabel(value.to)}`;

  return (
    <div className="range-picker">
      <button type="button" className="btn ghost" onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open ? (
        <div className="rangepop open">
          <div className="rp-row">
            <label htmlFor={`${id}-from`}>From</label>
            <input
              id={`${id}-from`}
              type="date"
              value={value.from}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
            />
          </div>
          <div className="rp-row">
            <label htmlFor={`${id}-to`}>To</label>
            <input
              id={`${id}-to`}
              type="date"
              value={value.to}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
            />
          </div>
          <div className="rp-actions">
            <button type="button" className="btn ghost" onClick={() => onChange({ from: '', to: '' })}>
              All time
            </button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>Apply</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
