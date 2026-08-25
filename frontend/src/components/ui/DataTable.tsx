import type { ReactNode } from 'react';
import { EmptyState } from './EmptyState';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string | number;
  /** Keeps `header` for screen readers while leaving the cell visually blank. */
  hideHeader?: boolean;
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
}

/**
 * Type-safe wrapper around the shared `.tablewrap > table` styles. Handles
 * loading, empty, and clickable-row cases so pages don't reimplement them.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const {
    columns, rows, rowKey, onRowClick, isLoading,
    emptyTitle = 'Nothing here yet.', emptyHint, emptyAction, footer,
  } = props;

  return (
    <div className="card">
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" style={{ textAlign: c.align, width: c.width }}>
                  {c.hideHeader ? <span className="sr-only">{c.header}</span> : c.header}
                </th>
              ))}
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
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
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
