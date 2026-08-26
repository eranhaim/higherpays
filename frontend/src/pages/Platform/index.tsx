import {
  PageHeader, Pill, DataTable, Money, DateCell, EmptyState, LoadingCard, ErrorCard, type Column,
} from '../../components/ui';
import type { PlatformWorkspace } from '../../api/endpoints';
import { usePlatformData } from './usePlatformData';

/**
 * The operator console: every tenant, not one of them. Access comes from
 * `platform_admins`, which is a tier above workspace roles — so this page sits
 * outside the workspace layout and is gated on its own check, not on a
 * permission from the active membership.
 */
export default function PlatformPage() {
  const { role, isCheckingAccess, isOperator, workspaces, isLoading, isError } = usePlatformData();

  const columns: Column<PlatformWorkspace>[] = [
    { key: 'organization', header: 'Agency', render: (w) => <span className="cname">{w.organization}</span> },
    { key: 'name', header: 'Workspace', render: (w) => w.name },
    {
      key: 'status',
      header: 'Status',
      render: (w) => <Pill tone={w.status === 'active' ? 'ok' : 'muted'}>{w.status}</Pill>,
    },
    { key: 'members', header: 'Members', align: 'right', render: (w) => <span className="mono">{w.members}</span> },
    { key: 'accounts', header: 'Accounts', align: 'right', render: (w) => <span className="mono">{w.accounts}</span> },
    { key: 'txns', header: 'Approved', align: 'right', render: (w) => <span className="mono">{w.approvedTxns}</span> },
    {
      key: 'volume',
      header: 'Gross volume',
      align: 'right',
      render: (w) => <Money amount={w.grossVolume} direction="in" />,
    },
    {
      key: 'activity',
      header: 'Last activity',
      align: 'right',
      render: (w) => <DateCell ts={w.lastActivity} />,
    },
  ];

  const header = (
    <PageHeader
      title="Platform"
      subtitle="Every agency on the platform. This view crosses tenants."
      actions={role ? <Pill>{role.replace('_', ' ')}</Pill> : null}
    />
  );

  if (isCheckingAccess) return null;
  if (!isOperator) {
    return (
      <div className="page">
        <div className="card">
          <EmptyState
            title="This console is for HigherPays operators."
            hint="Your account is not a platform admin."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      {header}
      {isLoading ? <LoadingCard label="Loading workspaces…" />
        : isError ? <ErrorCard message="Couldn't load the workspace list." />
          : (
            <DataTable
              columns={columns}
              rows={workspaces}
              rowKey={(w) => w.id}
              emptyTitle="No workspaces yet."
            />
          )}
    </div>
  );
}
