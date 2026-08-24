import type { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Colours the sub-line as a positive ("up") or negative ("down") change. */
  trend?: 'up' | 'down';
}

/**
 * One number in the KPI strip. Rendered as a border-less cell inside a
 * shared `.stats` container so a row of stats reads as a single band, the
 * way a ledger prints headline totals.
 */
export function StatCard({ label, value, sub, trend }: StatCardProps) {
  return (
    <div className="stat">
      <div className="lbl">{label}</div>
      <div className="val">{value}</div>
      {sub ? <div className={`sub${trend ? ` ${trend}` : ''}`}>{sub}</div> : null}
    </div>
  );
}

interface StatGridProps {
  children: ReactNode;
}

export function StatGrid({ children }: StatGridProps) {
  return <div className="stats">{children}</div>;
}
