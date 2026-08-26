import { useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useSessionStore } from '../../store/session';
import { useQueryClient } from '@tanstack/react-query';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import {
  PageHeader, Pill, DataTable, LoadingCard, ErrorCard, type Column,
} from '../../components/ui';
import type { MyWorkspace } from '../../api/endpoints';
import { useWorkspacesData } from './useWorkspacesData';

const CURRENCIES = ['EUR', 'USD', 'GBP'];

export default function WorkspacesPage() {
  const can = useCan();
  const { activeWorkspaceId } = useCurrentSession();
  const setActiveWorkspaceId = useSessionStore((s) => s.setActiveWorkspaceId);
  const queryClient = useQueryClient();
  const { workspaces, isLoading, isError, createWorkspace } = useWorkspacesData();

  const canCreate = can('workspaces.create');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [isSaving, setIsSaving] = useState(false);

  const switchTo = (id: string) => {
    if (id === activeWorkspaceId) return;
    setActiveWorkspaceId(id);
    // Every cached query is scoped to the old workspace.
    queryClient.clear();
    toast('Switched workspace.');
  };

  const submit = async () => {
    if (!name.trim()) { toast('Give the workspace a name.'); return; }
    setIsSaving(true);
    try {
      await createWorkspace(name.trim(), currency);
      setCreateOpen(false);
      setName('');
      setCurrency('EUR');
      toast('Workspace created. Set its MID before taking payments.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the workspace.');
    } finally {
      setIsSaving(false);
    }
  };

  const columns: Column<MyWorkspace>[] = [
    {
      key: 'name',
      header: 'Workspace',
      render: (w) => (
        <span className="cname">
          {w.name}
          {w.id === activeWorkspaceId ? <> <Pill tone="ok">Active</Pill></> : null}
        </span>
      ),
    },
    { key: 'organization', header: 'Organization', render: (w) => w.organization },
    { key: 'role', header: 'Your role', render: (w) => <Pill>{w.role}</Pill> },
    { key: 'currency', header: 'Currency', render: (w) => <span className="mono">{w.currency}</span> },
    {
      key: 'action',
      header: 'Open',
      hideHeader: true,
      align: 'right',
      render: (w) => (w.id === activeWorkspaceId ? null : (
        <button className="btn ghost small" onClick={() => switchTo(w.id)}>Switch to</button>
      )),
    },
  ];

  const header = (
    <PageHeader
      title="Workspaces"
      subtitle="Every workspace you belong to. Each one is a separate brand with its own MID."
      actions={canCreate ? <button className="btn" onClick={() => setCreateOpen(true)}>New workspace</button> : null}
    />
  );

  if (isLoading) return <div>{header}<LoadingCard label="Loading workspaces…" /></div>;
  if (isError) return <div>{header}<ErrorCard message="Couldn't load your workspaces." /></div>;

  return (
    <div>
      {header}
      <DataTable
        columns={columns}
        rows={workspaces}
        rowKey={(w) => w.id}
        emptyTitle="You don't belong to a workspace yet."
      />

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New workspace"
        subtitle="A second brand under this organization, with its own MID and payment links."
      >
        <div className="field">
          <label htmlFor="ws-name">Name</label>
          <input id="ws-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ws-currency">Currency</label>
          <select id="ws-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setCreateOpen(false)}>Cancel</button>
          <button className="btn" onClick={submit} disabled={isSaving}>
            {isSaving ? 'Creating…' : 'Create workspace'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
