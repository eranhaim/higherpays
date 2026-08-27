import type { AuditEntry } from '../../api/endpoints';
import { DataTable, DateCell, type Column } from '../../components/ui';
import { useAudit } from './useSettingsData';

/** "link.create" → "Link create". The action names are stable server-side keys. */
function describe(action: string): string {
  const text = action.replace(/[._]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Who did what in the workspace, newest first. */
export function ActivityPane() {
  const { entries, isLoading, isError, hasMore, isLoadingMore, loadMore } = useAudit();

  const columns: Column<AuditEntry>[] = [
    { key: 'when', header: 'When', render: (e) => <DateCell ts={e.createdAt} /> },
    {
      key: 'who', header: 'Who',
      render: (e) => e.actor
        ? <><div className="cname">{e.actor.name}</div><div className="cemail">{e.actor.email}</div></>
        : <span className="sub">System</span>,
    },
    { key: 'what', header: 'Action', render: (e) => describe(e.action) },
    { key: 'entity', header: 'Record', render: (e) => e.entityType ? <span className="mono">{e.entityType}</span> : '—' },
    { key: 'ip', header: 'From', render: (e) => <span className="mono">{e.ip ?? '—'}</span> },
  ];

  return (
    <DataTable
      columns={columns}
      rows={entries}
      rowKey={(e) => e.id}
      isLoading={isLoading}
      emptyTitle={isError ? "Couldn't load the activity log." : 'Nothing recorded yet.'}
      emptyHint={isError ? 'Try again in a moment.' : undefined}
      footer={
        <span className="table-foot-row">
          {entries.length} loaded
          {hasMore && (
            <button className="btn ghost small" onClick={loadMore} disabled={isLoadingMore}>{isLoadingMore ? 'Loading…' : 'Load more'}</button>
          )}
        </span>
      }
    />
  );
}
