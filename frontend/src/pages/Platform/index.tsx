import { Link } from 'react-router-dom';
import { PageHeader, Pill, DataTable, Money, DateCell, EmptyState, LoadingCard, ErrorCard, type Column } from '../../components/ui';
import type { PlatformWorkspace } from '../../api/endpoints';
import { usePlatformData } from './usePlatformData';

/**
 * The operator console: every agency, not one of them. Access comes from
 * `users.is_platform_admin`, a tier above workspace roles — so this page sits
 * outside the workspace layout and is gated on its own check.
 */
export default function PlatformPage() {
  const { isCheckingAccess, isPlatformAdmin, workspaces, isLoading, isError } = usePlatformData();

  const columns: Column<PlatformWorkspace>[] = [
    { key: 'name', header: 'Agency', render: (w) => <span className="cname">{w.name}</span> },
    { key: 'status', header: 'Status', render: (w) => <Pill tone={w.status === 'active' ? 'ok' : 'muted'}>{w.status}</Pill> },
    { key: 'currency', header: 'Currency', render: (w) => <span className="mono">{w.currency}</span> },
    { key: 'rate', header: 'Blended rate', align: 'right', render: (w) => <span className="mono">{w.blendedRatePct}%</span> },
    { key: 'members', header: 'Members', align: 'right', render: (w) => <span className="mono">{w.members}</span> },
    { key: 'accounts', header: 'Accounts', align: 'right', render: (w) => <span className="mono">{w.accounts}</span> },
    { key: 'agents', header: 'Agents', align: 'right', render: (w) => <span className="mono">{w.agents}</span> },
    { key: 'paid', header: 'Paid', align: 'right', render: (w) => <span className="mono">{w.paidPayments}</span> },
    { key: 'volume', header: 'Gross volume', align: 'right', render: (w) => <Money amount={w.grossVolume} currency={w.currency} direction="in" /> },
    { key: 'activity', header: 'Last activity', align: 'right', render: (w) => <DateCell ts={w.lastActivity} /> },
  ];

  if (isCheckingAccess) return null;
  if (!isPlatformAdmin) {
    return (
      <div className="page">
        <div className="card">
          <EmptyState title="This console is for HigherPays operators." hint="Your account is not a platform admin." />
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Platform"
        subtitle="Every agency on the platform. This view crosses workspaces."
        actions={<Link className="btn ghost" to="/payments">Back to the console</Link>}
      />
      {isLoading ? <LoadingCard label="Loading agencies…" />
        : isError ? <ErrorCard message="Couldn't load the agency list." />
          : <DataTable columns={columns} rows={workspaces} rowKey={(w) => w.id} emptyTitle="No agencies yet." />}
    </div>
  );
}
