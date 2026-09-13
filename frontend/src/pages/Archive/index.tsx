import { useState } from 'react';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { toast } from '../../lib/toast';
import Modal from '../../components/Modal';
import {
  PageHeader, DataTable, DateCell, Money, Pill, type Column,
} from '../../components/ui';
import { ARCHIVE_TABS, type ArchiveType, type ArchivedItem } from '../../api/endpoints';
import { useArchiveData } from './useArchiveData';

function ArchiveTable({ type }: { type: ArchiveType }) {
  const { items, isLoading, isError, restore, isRestoring } = useArchiveData(type);
  const [restoring, setRestoring] = useState<ArchivedItem | null>(null);

  const confirmRestore = async () => {
    if (!restoring) return;
    try {
      await restore(restoring.id);
      toast(`${restoring.name} restored.`);
      setRestoring(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not restore this item.');
    }
  };

  const columns: Column<ArchivedItem>[] = [
    {
      key: 'name',
      header: 'Item',
      render: (item) => (
        <div>
          <div className="cname">{item.name}</div>
          {item.detail && <div className="cemail">{item.detail}</div>}
        </div>
      ),
    },
    { key: 'status', header: 'Previous status', render: (item) => item.status ? <Pill tone="muted">{item.status}</Pill> : '—' },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (item) => item.amount == null ? '—' : <Money amount={item.amount} currency={item.currency ?? undefined} />,
    },
    { key: 'archived', header: 'Archived', render: (item) => <DateCell ts={item.archivedAt} /> },
    {
      key: 'actions',
      header: 'Actions',
      hideHeader: true,
      align: 'right',
      render: (item) => (
        <button className="btn ghost small" onClick={() => setRestoring(item)} disabled={isRestoring}>
          Restore
        </button>
      ),
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(item) => item.id}
        isLoading={isLoading}
        emptyTitle={isError ? 'Could not load the archive.' : 'Nothing archived here.'}
        emptyHint={isError ? 'Try again in a moment.' : 'Archived records stay available here until restored.'}
      />
      <Modal
        open={restoring !== null}
        onClose={() => setRestoring(null)}
        title={restoring ? `Restore ${restoring.name}?` : ''}
        subtitle="It will return to the normal operational lists and metrics. Financial history is not changed."
      >
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setRestoring(null)}>Keep archived</button>
          <button className="btn" onClick={() => void confirmRestore()} disabled={isRestoring}>
            {isRestoring ? 'Restoring…' : 'Restore'}
          </button>
        </div>
      </Modal>
    </>
  );
}

export default function ArchivePage() {
  const { user } = useCurrentSession();
  const tabs = ARCHIVE_TABS.filter((tab) => tab.type !== 'workspaces' || user?.isPlatformAdmin);
  const [type, setType] = useState<ArchiveType>(tabs[0].type);
  const activeType = tabs.some((tab) => tab.type === type) ? type : tabs[0].type;

  return (
    <div>
      <PageHeader
        title="Archive"
        subtitle="Restore operational records when they should return to normal lists. Financial history is retained."
      />
      <div className="tabbar" role="tablist" aria-label="Archived entity types">
        {tabs.map((tab) => (
          <button
            key={tab.type}
            type="button"
            role="tab"
            aria-selected={activeType === tab.type}
            className={`btn ghost tgl${activeType === tab.type ? ' active' : ''}`}
            onClick={() => setType(tab.type)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <ArchiveTable type={activeType} />
    </div>
  );
}
