import { useEffect, useRef, useState } from 'react';
import type { ViewLayoutState } from '../../hooks/useViewLayout';

interface ViewPickerProps {
  label: string;
  view: ViewLayoutState;
}

/** The button and popover that drive a `useViewLayout`. */
export function ViewPicker({ label, view }: ViewPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const toggle = (key: string) => {
    const hidden = view.hidden.includes(key)
      ? view.hidden.filter((k) => k !== key)
      : [...view.hidden, key];
    view.setLayout({ order: view.order, hidden });
  };

  const move = (index: number, by: 1 | -1) => {
    const order = [...view.order];
    const [moved] = order.splice(index, 1);
    order.splice(index + by, 0, moved);
    view.setLayout({ order, hidden: view.hidden });
  };

  return (
    <div className="view-picker" ref={rootRef}>
      <button type="button" className="btn ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open ? (
        <div className="viewpop right">
          {view.order.map((key, index) => {
            const item = view.items.find((i) => i.key === key);
            if (!item) return null;
            return (
              <div className="viewpop-row" key={key}>
                <label>
                  <input type="checkbox" checked={!view.hidden.includes(key)} onChange={() => toggle(key)} />
                  <span>{item.label}</span>
                </label>
                <button
                  type="button" className="btn ghost small" aria-label={`Move ${item.label} up`}
                  disabled={index === 0} onClick={() => move(index, -1)}
                >↑</button>
                <button
                  type="button" className="btn ghost small" aria-label={`Move ${item.label} down`}
                  disabled={index === view.order.length - 1} onClick={() => move(index, 1)}
                >↓</button>
              </div>
            );
          })}
          <div className="viewpop-actions">
            <button type="button" className="btn ghost small" onClick={view.reset}>Reset</button>
            <button type="button" className="btn small" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
