import { useMemo, useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import { initials } from '../../lib/format';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { PageHeader, DataTable, FilterBar, Pill, Select, ViewPicker, type Column, type SortState } from '../../components/ui';
import { useViewLayout, orderBy } from '../../hooks/useViewLayout';
import { sortRows, type SortValues } from '../../lib/sortRows';
import { COUNTRIES, countryName } from '../../lib/countries';
import type { Agent } from '../../api/endpoints';
import { useAgentsData } from './useAgentsData';

const SORT_VALUES: SortValues<Agent> = {
  name: (a) => a.name,
  status: (a) => a.status,
  accounts: (a) => a.accountsAssigned,
  commission: (a) => a.commissionPct,
  country: (a) => a.country,
};

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
  const [access, setAccess] = useState<'' | 'active' | 'suspended'>('');
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

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
  const matching = query ? agents.filter((a) => `${a.name} ${a.email}`.toLowerCase().includes(query)) : agents;
  const shown = access ? matching.filter((a) => a.status === access) : matching;
  // The server returns every agent at once, so the order is decided here.
  const visible = useMemo(() => sortRows(shown, sort, SORT_VALUES), [shown, sort]);

  const columns: Column<Agent>[] = [
    {
      key: 'person', header: labels.agent, sortKey: 'name',
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
    {
      key: 'status', header: 'Access', sortKey: 'status',
      render: (a) => a.status === 'active' ? <Pill tone="ok">Active</Pill> : <Pill tone="muted">Suspended</Pill>,
      isFiltered: access !== '',
      filter: (
        <Select label="Access" hideLabel value={access} onChange={(v) => setAccess(v as '' | 'active' | 'suspended')}>
          <option value="">All access</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </Select>
      ),
    },
    { key: 'accounts', header: labels.accounts, sortKey: 'accounts', render: (a) => <span className="mono">{a.accountsAssigned}</span> },
    ...(canViewCommission ? [{
      key: 'commission', header: 'Commission', sortKey: 'commission',
      render: (a: Agent) => <span className="mono">{a.commissionPct}%</span>,
    }] : []),
    { key: 'country', header: 'Country', sortKey: 'country', render: (a) => countryName(a.country) || '—' },
  ];

  const columnsView = useViewLayout('agents.columns', columns.map((c) => ({ key: c.key, label: c.header })));
  const shownColumns: Column<Agent>[] = [
    ...orderBy(columns, columnsView.visibleKeys),
    // The actions cell is a control, not data: it is never hidden or moved.
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
        actions={canManage ? <button className="btn" onClick={() => setCreateOpen(true)}>Add {labels.agent.toLowerCase()}</button> : null}
      />

      {agents.length > 0 && (
        <FilterBar>
          <input type="search" className="search-input" aria-label={`Search ${labels.agents}`}
            placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn ghost" onClick={() => { setSearch(''); setAccess(''); }}>Clear filters</button>
          <span className="sub">{visible.length} of {agents.length}</span>
          <ViewPicker label="Edit columns" view={columnsView} />
        </FilterBar>
      )}

      <DataTable
        columns={shownColumns}
        rows={visible}
        rowKey={(a) => a.id}
        isLoading={isLoading}
        sort={sort}
        onSort={toggleSort}
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
            await updateAgent(editing.id, { fullName: values.fullName, commissionPct: values.commissionPct, country: values.country });
            setEditing(null);
            toast('Saved.');
          }}
        />
      )}

      <Modal open={suspending !== null} onClose={() => setSuspending(null)} title={suspending ? `Suspend ${suspending.name}?` : ''}
        subtitle="They are signed out everywhere and cannot sign in again until reactivated. Their links, payments and commission are all kept.">
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
    if (!fullName.trim()) { toast('Name is required.'); return; }
    if (creating && !email.trim()) { toast('Email is required.'); return; }
    if (creating && password.length < 8) { toast('Password must be at least 8 characters.'); return; }
    if (Number.isNaN(commission)) { toast('Commission must be 0–100.'); return; }
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
            <input id="agent-name" type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} />
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
          <Select id="agent-country" label="Country" value={country} onChange={setCountry}>
            <option value="">Not set</option>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </Select>
          {/* What someone earns is a revenue decision; without that permission
              the field is absent rather than shown greyed out. */}
          {canEditCommission && (
            <div className="field">
              <label htmlFor="agent-commission">Commission on each sale</label>
              <div className="pct-input">
                <input id="agent-commission" type="number" min={0} max={100} value={commissionText}
                  aria-invalid={Number.isNaN(commission) || undefined}
                  onChange={(e) => setCommissionText(e.target.value)} />
                <span className="sub">%</span>
              </div>
              <p className="sub">Share of the distributable amount, after fees. Together with the {labels.account.toLowerCase()} share it must fit in 100%.</p>
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={isSaving}>{isSaving ? 'Saving…' : creating ? `Add ${labels.agent.toLowerCase()}` : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
  );
}
