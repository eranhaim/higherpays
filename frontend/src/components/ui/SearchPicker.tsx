import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

export interface PickerItem {
  id: string;
  name: string;
  /** Small line under the name: a status, or who it is assigned to now. */
  hint?: string;
}

/** Rows drawn at once. A list of hundreds stays quick; "Show more" reveals the rest. */
const PAGE_SIZE = 50;

/**
 * Choose any number of items from a list that may be long. Selected items sit
 * on top as removable chips, the list below filters as you type, and the whole
 * thing works from the keyboard: type to filter, arrows to move, Enter to add
 * or remove, Backspace on an empty field to drop the last chip.
 */
export function SearchPicker({ label, hint, items, selected, onChange, noun, emptyText }: {
  label: string;
  hint?: string;
  items: PickerItem[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Lower-case plural, for the counts: "creators". */
  noun: string;
  /** Shown when the list itself is empty, not when a search finds nothing. */
  emptyText: string;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const activeRef = useRef<HTMLLIElement | null>(null);

  const term = search.trim().toLowerCase();
  const matches = useMemo(
    () => items.filter((item) => !term || `${item.name} ${item.hint ?? ''}`.toLowerCase().includes(term)),
    [items, term],
  );
  const visible = matches.slice(0, limit);
  const chips = selected.map((itemId) => items.find((item) => item.id === itemId)).filter((item) => item !== undefined);

  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [activeIndex]);

  const toggle = (itemId: string) => onChange(
    selected.includes(itemId) ? selected.filter((current) => current !== itemId) : [...selected, itemId],
  );

  const changeSearch = (value: string) => {
    setSearch(value);
    setActiveIndex(0);
    setLimit(PAGE_SIZE);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, visible.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      // Inside a form, Enter must not submit it.
      event.preventDefault();
      if (visible[activeIndex]) toggle(visible[activeIndex].id);
    } else if (event.key === 'Backspace' && !search && selected.length > 0) {
      onChange(selected.slice(0, -1));
    } else if (event.key === 'Escape' && search) {
      // First Escape clears the search; the dialog stays open.
      event.stopPropagation();
      changeSearch('');
    }
  };

  const listId = `${id}-list`;
  const activeId = visible[activeIndex] ? `${id}-option-${visible[activeIndex].id}` : undefined;

  return (
    <div className="field picker">
      <label htmlFor={`${id}-input`}>{label}</label>
      {hint && <p className="sub">{hint}</p>}
      {items.length === 0 ? <p className="sub">{emptyText}</p> : (
        <>
          {chips.length > 0 && (
            <ul className="picker-chips" aria-label={`Selected ${noun}`}>
              {chips.map((item) => (
                <li key={item.id} className="picker-chip">
                  <span>{item.name}</span>
                  <button type="button" aria-label={`Remove ${item.name}`} onClick={() => toggle(item.id)}>×</button>
                </li>
              ))}
            </ul>
          )}
          <input
            id={`${id}-input`} type="search" role="combobox" autoComplete="off"
            aria-expanded="true" aria-controls={listId} aria-activedescendant={activeId}
            placeholder={`Search ${noun}`} value={search}
            onChange={(event) => changeSearch(event.target.value)} onKeyDown={onKeyDown}
          />
          <p className="sub picker-count" aria-live="polite">
            {selected.length} selected
            {term ? `, ${matches.length} of ${items.length} match` : `, ${items.length} in total`}
          </p>
          {matches.length === 0 ? (
            <p className="sub picker-empty">No {noun} match “{search.trim()}”.</p>
          ) : (
            <ul id={listId} className="picker-list" role="listbox" aria-multiselectable="true" aria-label={label}>
              {visible.map((item, index) => {
                const isSelected = selected.includes(item.id);
                const isActive = index === activeIndex;
                return (
                  // The input owns the keyboard (aria-activedescendant), so the
                  // option itself is a pointer target only.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                  <li
                    key={item.id} id={`${id}-option-${item.id}`} role="option" aria-selected={isSelected}
                    ref={isActive ? activeRef : undefined}
                    className={['picker-row', isActive ? 'active' : null].filter(Boolean).join(' ')}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => { setActiveIndex(index); toggle(item.id); }}
                  >
                    <span className="picker-text">
                      <span className="picker-name">{item.name}</span>
                      {item.hint && <span className="sub picker-hint">{item.hint}</span>}
                    </span>
                    <span className="picker-action">{isSelected ? 'Remove' : 'Add'}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {matches.length > visible.length && (
            <button type="button" className="btn ghost small" onClick={() => setLimit((current) => current + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, matches.length - visible.length)} more ({matches.length - visible.length} hidden)
            </button>
          )}
        </>
      )}
    </div>
  );
}
