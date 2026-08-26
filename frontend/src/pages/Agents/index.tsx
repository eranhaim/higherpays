import { useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import { initials } from '../../lib/format';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { PageHeader, DataTable, FilterBar, Pill, type Column } from '../../components/ui';
import type { Agent } from '../../api/endpoints';
import { useAgentsData } from './useAgentsData';

/** NaN for anything that isn't a usable percentage, so callers can flag it. */
function parsePct(text: string): number {
  const n = parseFloat(text);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : Number.NaN;
}

export default function AgentsPage() {
  const can = useCan();
  const { labels } = useCurrentSession();
  const canManage = can('agents.manage');
  const canViewCommission = can('revenue.view');
  const { agents, isLoading, isError, createAgent, updateAgent, setStatus } = useAgentsData();

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [suspending, setSuspending] = useState<Agent | null>(null);
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [search, setSearch] = useState('');

  useUnsavedChanges('agent-form', createOpen || editing !== null);

  const changeStatus = async (a: Agent, status: 'active' | 'suspended') => {
    setIsChangingStatus(true);
    try {
      await setStatus(a, status);
      setSuspending(null);
      toast(status === 'active' ? `${a.name} can sign in again.` : `${a.name} suspended. Their history stays.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change access.');
    } finally {
      setIsChangingStatus(false);
    }
  };

  const query = search.trim().toLowerCase();
  const visible = query ? agents.filter((a) => `${a.name} ${a.email}`.toLowerCase().includes(query)) : agents;

  const columns: Column<Agent>[] = [
    {
      key: 'person', header: labels.agent,
      render: (a) => (
        <div className="person">
          <div className="avatar">{initials(a.name)}</div>
          <div>
            <div className="cname">{a.name}</div>
            <div className="cemail">{a.email}</div>
          </div>
        </div>
      ),
    },
    { key: 'status', header: 'Access', render: (a) => a.status === 'active' ? <Pill tone="ok">Active</Pill> : <Pill tone="muted">Suspended</Pill> },
    { key: 'accounts', header: labels.accounts, align: 'right', render: (a) => <span className="mono">{a.accountsAssigned}</span> },
    ...(canViewCommission ? [{
      key: 'commission', header: 'Commission', align: 'right' as const,
      render: (a: Agent) => <span className="mono">{a.commissionPct}%</span>,
    }] : []),
    { key: 'country', header: 'Country', render: (a) => a.country ?? '—' },
    ...(canManage ? [{
      key: 'actions', header: 'Actions', hideHeader: true, align: 'right' as const,
      render: (a: Agent) => (
        <div className="cell-actions">
          <button className="btn ghost small" onClick={() => setEditing(a)}>Edit</button>
          {a.status === 'active'
            ? <button className="btn ghost small" onClick={() => setSuspending(a)}>Suspend</button>
            : <button className="btn ghost small" onClick={() => changeStatus(a, 'active')} disabled={isChangingStatus}>Reactivate</button>}
        </div>
      ),
    }] : []),
  ];

  return (
    <div>
      <PageHeader
        title={labels.agents}
        subtitle={`The people who sell for your ${labels.accounts.toLowerCase()}, and what each one earns on a sale.`}
        actions={canManage ? <button className="btn" onClick={() => setCreateOpen(true)}>Add {labels.agent.toLowerCase()}</button> : null}
      />

      {agents.length > 0 && (
        <FilterBar>
          <input type="search" className="search-input" aria-label={`Search ${labels.agents}`}
            placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="sub">{visible.length} of {agents.length}</span>
        </FilterBar>
      )}

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(a) => a.id}
        isLoading={isLoading}
        emptyTitle={isError ? `Couldn't load ${labels.agents.toLowerCase()}.` : query ? 'Nothing matches that search.' : `No ${labels.agents.toLowerCase()} yet.`}
        emptyHint={isError ? 'Try again in a moment.' : query ? 'Clear the search to see them all.' : canManage ? 'Add the first one from the header.' : undefined}
      />

      {createOpen && (
        <AgentFormModal
          title={`Add ${labels.agent.toLowerCase()}`}
          subtitle={`Creates the ${labels.agent.toLowerCase()} and their login in one go.`}
          canEditCommission={can('revenue.manage')}
          onClose={() => setCreateOpen(false)}
          onSubmit={async (values) => {
            await createAgent(values);
            setCreateOpen(false);
            toast(`${labels.agent} added.`);
          }}
        />
      )}

      {editing && (
        <AgentFormModal
          title={`Edit ${editing.name}`}
          agent={editing}
          canEditCommission={can('revenue.manage')}
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            await updateAgent(editing.id, { commissionPct: values.commissionPct, country: values.country });
            setEditing(null);
            toast('Saved.');
          }}
        />
      )}

      <Modal open={suspending !== null} onClose={() => setSuspending(null)} title={suspending ? `Suspend ${suspending.name}?` : ''}
        subtitle="They are signed out everywhere and cannot sign in again until reactivated. Their links, payments and commission stay in the ledger.">
        {suspending && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setSuspending(null)}>Keep</button>
            <button className="btn danger" disabled={isChangingStatus} onClick={() => changeStatus(suspending, 'suspended')}>
              {isChangingStatus ? 'Suspending…' : 'Suspend'}
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}

interface AgentFormValues {
  email: string;
  fullName: string;
  password?: string;
  country?: string;
  commissionPct: number;
}

interface AgentFormModalProps {
  title: string;
  subtitle?: string;
  agent?: Agent;
  canEditCommission: boolean;
  onClose: () => void;
  onSubmit: (values: AgentFormValues) => Promise<void>;
}

function AgentFormModal({ title, subtitle, agent, canEditCommission, onClose, onSubmit }: AgentFormModalProps) {
  const { labels } = useCurrentSession();
  const [fullName, setFullName] = useState(agent?.name ?? '');
  const [email, setEmail] = useState(agent?.email ?? '');
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState(agent?.country ?? '');
  const [commissionText, setCommissionText] = useState(String(agent?.commissionPct ?? 0));
  const [isSaving, setIsSaving] = useState(false);
  const commission = parsePct(commissionText);
  const creating = !agent;

  const submit = async () => {
    if (creating && (!fullName.trim() || !email.trim())) { toast('Name and email are required.'); return; }
    if (creating && password.length < 8) { toast('Password must be at least 8 characters.'); return; }
    if (Number.isNaN(commission)) { toast('Commission must be 0–100.'); return; }
    if (country && !/^[A-Za-z]{2}$/.test(country)) { toast('Country is a 2-letter code.'); return; }
    setIsSaving(true);
    try {
      await onSubmit({
        email: email.trim(), fullName: fullName.trim(),
        ...(creating ? { password } : {}),
        country: country.trim() || undefined,
        commissionPct: commission,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={title} subtitle={subtitle}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="form-row">
          <div className="field">
            <label htmlFor="agent-name">Full name</label>
            <input id="agent-name" type="text" value={fullName} disabled={!creating} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="agent-email">Email</label>
            <input id="agent-email" type="email" value={email} disabled={!creating} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
        {creating && (
          <div className="field">
            <label htmlFor="agent-password">Password</label>
            <input id="agent-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="sub">At least 8 characters. Ignored if this email already has a login.</p>
          </div>
        )}
        <div className="form-row">
          <div className="field">
            <label htmlFor="agent-country">Country</label>
            <input id="agent-country" type="text" maxLength={2} placeholder="e.g. IL" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
          </div>
          <div className="field">
            <label htmlFor="agent-commission">Commission on each sale</label>
            <div className="pct-input">
              <input id="agent-commission" type="number" min={0} max={100} value={commissionText}
                aria-invalid={Number.isNaN(commission) || undefined} disabled={!canEditCommission}
                onChange={(e) => setCommissionText(e.target.value)} />
              <span className="sub">%</span>
            </div>
            <p className="sub">Share of the distributable amount, after fees. Together with the {labels.account.toLowerCase()} share it must fit in 100%.</p>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={isSaving}>{isSaving ? 'Saving…' : creating ? `Add ${labels.agent.toLowerCase()}` : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
  );
}
