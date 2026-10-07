import { useEffect, useRef, useState } from 'react';
import type { ViewLayoutState } from '../../hooks/useViewLayout';

export interface ViewSection {
  /** Names the group in the popover. Omit on a single-section picker. */
  label?: string;
  view: ViewLayoutState;
}

interface ViewPickerProps {
  label: string;
  sections?: ViewSection[];
  /**
   * Temporary: `Accounts` and `Agents` are being replaced by the consolidated
   * members list, so they still pass one layout directly. Delete this prop and
   * its branch once that page lands and those two are gone.
   */
  view?: ViewLayoutState;
}

/**
 * One button and one popover for every layout a page lets the user rearrange —
 * its stat cards and its table columns. They were two separate pickers in two
 * separate places, which is why nobody could find either.
 */
export function ViewPicker({ label, sections, view }: ViewPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const groups = sections ?? (view ? [{ view }] : []);

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

  const toggle = (target: ViewLayoutState, key: string) => {
    const hidden = target.hidden.includes(key)
      ? target.hidden.filter((k) => k !== key)
      : [...target.hidden, key];
    target.setLayout({ order: target.order, hidden });
  };

  const move = (target: ViewLayoutState, index: number, by: 1 | -1) => {
    const order = [...target.order];
    const [moved] = order.splice(index, 1);
    order.splice(index + by, 0, moved);
    target.setLayout({ order, hidden: target.hidden });
  };

  return (
    <div className="view-picker" ref={rootRef}>
      <button type="button" className="btn ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open ? (
        <div className="viewpop right" role="group" aria-label={label}>
          {groups.map((group) => (
            <div key={group.label ?? 'only'}>
              {group.label ? <div className="viewpop-group">{group.label}</div> : null}
              {group.view.order.map((key, index) => {
                const item = group.view.items.find((i) => i.key === key);
                if (!item) return null;
                return (
                  <div className="viewpop-row" key={key}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!group.view.hidden.includes(key)}
                        onChange={() => toggle(group.view, key)}
                      />
                      <span>{item.label}</span>
                    </label>
                    <button
                      type="button" className="btn ghost small" aria-label={`Move ${item.label} up`}
                      disabled={index === 0} onClick={() => move(group.view, index, -1)}
                    >↑</button>
                    <button
                      type="button" className="btn ghost small" aria-label={`Move ${item.label} down`}
                      disabled={index === group.view.order.length - 1} onClick={() => move(group.view, index, 1)}
                    >↓</button>
                  </div>
                );
              })}
            </div>
          ))}
          <div className="viewpop-actions">
            <button type="button" className="btn ghost small" onClick={() => groups.forEach((g) => g.view.reset())}>
              Reset
            </button>
            <button type="button" className="btn small" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
