import type { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Colours the sub-line as a positive ("up") or negative ("down") change. */
  trend?: 'up' | 'down';
  /**
   * The number isn't known yet, or the request for it failed. Shows a dash
   * rather than a zero, which would read as a real figure.
   */
  isUnknown?: boolean;
}

/**
 * One number in the KPI strip. Rendered as a border-less cell inside a
 * shared `.stats` container so a row of stats reads as a single band, the
 * way a ledger prints headline totals.
 */
export function StatCard({ label, value, sub, trend, isUnknown }: StatCardProps) {
  return (
    <div className="stat">
      <div className="lbl">{label}</div>
      <div className="val">{isUnknown ? '—' : value}</div>
      {sub && !isUnknown ? <div className={`sub${trend ? ` ${trend}` : ''}`}>{sub}</div> : null}
    </div>
  );
}

interface StatGridProps {
  children: ReactNode;
}

export function StatGrid({ children }: StatGridProps) {
  return <div className="stats">{children}</div>;
}
