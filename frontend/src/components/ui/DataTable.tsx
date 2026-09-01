import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { EmptyState } from './EmptyState';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string | number;
  /** Keeps `header` for screen readers while leaving the cell visually blank. */
  hideHeader?: boolean;
  /** Sortable when set: the name the server sorts by. */
  sortKey?: string;
  /** What the header's filter popover shows. Omitted, the header has none. */
  filter?: ReactNode;
  /** Marks the header while its filter is narrowing the list. */
  isFiltered?: boolean;
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  /** Index is a valid key only for read-only lists replaced wholesale. */
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  isLoading?: boolean;
  emptyTitle?: string;
  emptyHint?: ReactNode;
  emptyAction?: ReactNode;
  footer?: ReactNode;
  sort?: SortState;
  /** Given a column's `sortKey`. The page decides the new direction. */
  onSort?: (sortKey: string) => void;
}

/**
 * Type-safe wrapper around the shared `.tablewrap > table` styles. Handles
 * loading, empty, and clickable-row cases so pages don't reimplement them.
 * Sorting and filtering live in the column headers; the page owns the state
 * and the queries, the table only reports what was clicked.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const {
    columns, rows, rowKey, onRowClick, isLoading,
    emptyTitle = 'Nothing here yet.', emptyHint, emptyAction, footer, sort, onSort,
  } = props;

  return (
    <div className="tableblock">
      {/* The footer sits outside the scroll container so it stays put while
          the rows scroll under the sticky header. */}
      <div className="tablewrap flush">
        <table>
          <thead>
            <tr>
              {columns.map((c) => {
                const sorted = sort && c.sortKey && sort.key === c.sortKey ? sort.dir : null;
                return (
                  <th
                    key={c.key} scope="col" style={{ textAlign: c.align, width: c.width }}
                    aria-sort={!c.sortKey ? undefined : sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                  >
                    {c.hideHeader ? <span className="sr-only">{c.header}</span> : (
                      <span className="th-inner">
                        {c.sortKey && onSort ? (
                          <button type="button" className="th-sort" onClick={() => onSort(c.sortKey as string)}>
                            {c.header}
                            <span className="th-caret" aria-hidden="true">{sorted === 'asc' ? '↑' : sorted === 'desc' ? '↓' : '↕'}</span>
                          </button>
                        ) : c.header}
                        {c.filter ? <HeaderFilter label={c.header} isActive={c.isFiltered}>{c.filter}</HeaderFilter> : null}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={columns.length} className="table-note">Loading…</td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <EmptyState title={emptyTitle} hint={emptyHint} action={emptyAction} />
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr
                  key={rowKey(row, index)}
                  className={onRowClick ? 'clickable' : undefined}
                  // A row is only reachable by keyboard if it says it is one.
                  // Without this the detail modals behind onRowClick are
                  // mouse-only.
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? 'button' : undefined}
                  // A button or link inside the row is its own action; clicking
                  // it must not also open the row.
                  onClick={onRowClick ? (e) => {
                    if ((e.target as HTMLElement).closest('button, a, input, select, label')) return;
                    onRowClick(row);
                  } : undefined}
                  onKeyDown={onRowClick ? (e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    onRowClick(row);
                  } : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} style={{ textAlign: c.align }}>{c.render(row)}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {footer ? <div className="table-foot">{footer}</div> : null}
    </div>
  );
}

/** Widest the popover gets. Used to keep it on screen. */
const POPOVER_WIDTH = 260;

/**
 * A column's filter, in its header. The popover is rendered into the body and
 * positioned against the button: the header is sticky inside a scrolling
 * container, which would otherwise clip it.
 */
function HeaderFilter({ label, isActive, children }: { label: string; isActive?: boolean; children: ReactNode }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null); };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setAt(null);
    };
    // The popover is anchored to a position rather than to the element, so
    // anything that scrolls or resizes moves the header out from under it.
    const close = () => setAt(null);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [at]);

  const toggle = () => {
    if (at) { setAt(null); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAt({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8)) });
  };

  return (
    <>
      <button
        ref={triggerRef} type="button" className={`th-filter${isActive ? ' on' : ''}`}
        aria-label={`Filter by ${label}`} aria-expanded={at !== null} onClick={toggle}
      >
        ▾
      </button>
      {at && createPortal(
        <div ref={popRef} className="viewpop th-filter-pop" style={{ position: 'fixed', top: at.top, left: at.left }}>
          {children}
          <div className="viewpop-actions">
            <span className="sub">{label}</span>
            <button type="button" className="btn small" onClick={() => setAt(null)}>Done</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
