import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}

/**
 * Consistent zero-data placeholder. Prefer this over inline "No X found"
 * messages so tables and cards read the same across pages.
 */
export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
