import { useMemo, useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { PageHeader, Pill, DataTable, FilterBar, Select, ViewPicker, type Column, type SortState } from '../../components/ui';
import { useViewLayout, orderBy } from '../../hooks/useViewLayout';
import { sortRows, type SortValues } from '../../lib/sortRows';
import { ACCOUNT_STATUS_LABELS, type Account, type AccountStatus, type UpdateAccountInput } from '../../api/endpoints';
import { useAccountsData, useAccountDetail } from './useAccountsData';

const SORT_VALUES: SortValues<Account> = {
  name: (a) => a.name,
  status: (a) => a.status,
  share: (a) => a.revenueSplitPct ?? null,
  agents: (a) => a.agentsAssigned ?? 0,
  country: (a) => a.country,
};

const DEFAULT_SPLIT_PCT = 70;

const STATUS_TONE: Record<AccountStatus, 'ok' | 'warn' | 'muted'> = {
  active: 'ok',
  paused: 'warn',
  archived: 'muted',
};

/** NaN for anything that isn't a usable percentage, so callers can flag it. */
function parsePct(text: string): number {
  const n = parseFloat(text);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : Number.NaN;
}

export default function AccountsPage() {
  const can = useCan();
  const { labels } = useCurrentSession();
  const canManage = can('accounts.manage');
  const canViewSplits = can('revenue.view');
  const canEditSplits = can('revenue.manage');
  const { accounts, agents, isLoading, isError, createAccount, updateAccount, setAssignedAgents } = useAccountsData(canManage);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  // Activating is harmless; pausing stops every new link and archiving hides
  // the account, so those two are confirmed.
  const [confirming, setConfirming] = useState<{ account: Account; status: 'paused' | 'archived' } | null>(null);
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [search, setSearch] = useState('');
  // '' hides archived, which is what someone running the roster wants by
  // default; picking "Archived" is how you go looking for one.
  const [statusFilter, setStatusFilter] = useState<'' | 'all' | AccountStatus>('');
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  useUnsavedChanges('account-edit', editing !== null || createOpen);

  const applyStatus = async (a: Account, status: AccountStatus) => {
    setIsChangingStatus(true);
    try {
      await updateAccount(a.id, { status });
      setConfirming(null);
      toast(status === 'active' ? `${a.name} activated.` : status === 'paused' ? `${a.name} paused. No new links.` : `${a.name} archived.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : `Could not update the ${labels.account.toLowerCase()}.`);
    } finally {
      setIsChangingStatus(false);
    }
  };

  const query = search.trim().toLowerCase();
  const matching = accounts
    .filter((a) => {
      if (statusFilter === 'all') return true;
      if (statusFilter !== '') return a.status === statusFilter;
      // The plain roster hides archived rows, but a search is a hunt for
      // someone in particular — finding nothing there reads as data loss.
      return query !== '' || a.status !== 'archived';
    })
    .filter((a) => !query || `${a.name} ${a.handle ?? ''} ${a.ownerName} ${a.ownerEmail}`.toLowerCase().includes(query));
  // The server returns every account at once, so the order is decided here.
  const visible = useMemo(() => sortRows(matching, sort, SORT_VALUES), [matching, sort]);

  const columns: Column<Account>[] = [
    {
      key: 'account', header: labels.account, sortKey: 'name',
      render: (a) => (
        <>
          <div className="cname">{a.name}</div>
          <div className="cemail">{a.handle ?? a.ownerEmail}</div>
        </>
      ),
    },
    {
      key: 'status', header: 'Status', sortKey: 'status',
      render: (a) => <Pill tone={STATUS_TONE[a.status]}>{ACCOUNT_STATUS_LABELS[a.status]}</Pill>,
      isFiltered: statusFilter !== '',
      filter: (
        <Select label="Status" hideLabel value={statusFilter} onChange={(v) => setStatusFilter(v as '' | 'all' | AccountStatus)}>
          <option value="">Active and paused</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
          <option value="all">All statuses</option>
        </Select>
      ),
    },
    ...(canViewSplits ? [{
      key: 'share', header: `Share (${labels.account.toLowerCase()} / agency)`, sortKey: 'share',
      render: (a: Account) => a.revenueSplitPct === undefined ? '—' : <span className="mono">{a.revenueSplitPct}% / {100 - a.revenueSplitPct}%</span>,
    }] : []),
    ...(canManage ? [{
      key: 'agents', header: labels.agents, sortKey: 'agents',
      render: (a: Account) => <span className="mono">{a.agentsAssigned ?? 0}</span>,
    }] : []),
    { key: 'country', header: 'Country', sortKey: 'country', render: (a) => a.country ?? '—' },
  ];

  const columnsView = useViewLayout('accounts.columns', columns.map((c) => ({ key: c.key, label: c.header })));
  const shownColumns: Column<Account>[] = [
    ...orderBy(columns, columnsView.visibleKeys),
    // The actions cell is a control, not data: it is never hidden or moved.
    ...(canManage ? [{
      key: 'actions', header: 'Actions', hideHeader: true, align: 'right' as const,
      render: (a: Account) => (
        <div className="cell-actions">
          <button className="btn ghost small" onClick={() => setEditing(a)}>Edit</button>
          {a.status === 'active' && <button className="btn ghost small" onClick={() => setConfirming({ account: a, status: 'paused' })}>Pause</button>}
          {a.status !== 'active' && <button className="btn ghost small" disabled={isChangingStatus} onClick={() => applyStatus(a, 'active')}>Activate</button>}
          {a.status !== 'archived' && <button className="btn ghost small" onClick={() => setConfirming({ account: a, status: 'archived' })}>Archive</button>}
        </div>
      ),
    }] : []),
  ];

  return (
    <div>
      <PageHeader
        title={labels.accounts}
        actions={canManage ? <button className="btn" onClick={() => setCreateOpen(true)}>Add {labels.account.toLowerCase()}</button> : null}
      />

      {accounts.length > 0 && (
        <FilterBar>
          <input type="search" className="search-input" aria-label={`Search ${labels.accounts}`}
            placeholder="Search name, handle or owner" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="sub">{visible.length} of {accounts.length}</span>
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
        emptyTitle={isError ? `Couldn't load ${labels.accounts.toLowerCase()}.` : query ? 'Nothing matches that search.' : `No ${labels.accounts.toLowerCase()} yet.`}
        emptyHint={isError ? 'Try again in a moment.' : query ? 'Clear the search to see them all.' : canManage ? 'Add the first one to start generating links.' : 'Ask an admin to add one.'}
      />

      {createOpen && (
        <CreateAccountModal
          agents={agents}
          onClose={() => setCreateOpen(false)}
          onSubmit={async (input, agentIds) => {
            await createAccount(input, agentIds);
            setCreateOpen(false);
            toast(`${labels.account} added.`);
          }}
        />
      )}

      {editing && (
        <EditAccountModal
          account={editing}
          agents={agents}
          canEditSplits={canEditSplits}
          onClose={() => setEditing(null)}
          onSubmit={async (input, agentIds) => {
            await updateAccount(editing.id, input);
            await setAssignedAgents(editing, agentIds);
            setEditing(null);
            toast(`${labels.account} updated.`);
          }}
        />
      )}

      <Modal open={confirming !== null} onClose={() => setConfirming(null)}
        title={confirming ? `${confirming.status === 'paused' ? 'Pause' : 'Archive'} ${confirming.account.name}?` : ''}
        subtitle={confirming?.status === 'paused'
          ? 'No new payment links can be created. Links already out there keep working, and nothing changes in the ledger.'
          : 'The account leaves every picker and list. Its history, payments and balances stay, and it can be activated again later.'}>
        {confirming && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setConfirming(null)}>Keep as is</button>
            <button className={confirming.status === 'archived' ? 'btn danger' : 'btn'} disabled={isChangingStatus} onClick={() => applyStatus(confirming.account, confirming.status)}>
              {isChangingStatus ? 'Saving…' : confirming.status === 'paused' ? 'Pause' : 'Archive'}
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}

interface CreateAccountModalProps {
  agents: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: (input: { email: string; fullName: string; password: string; name: string; country?: string; revenueSplitPct: number }, agentIds: string[]) => Promise<void>;
}

/** An account and the login of the person who owns it, in one form. */
function CreateAccountModal({ agents, onClose, onSubmit }: CreateAccountModalProps) {
  const { labels } = useCurrentSession();
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [splitText, setSplitText] = useState(String(DEFAULT_SPLIT_PCT));
  const [assigned, setAssigned] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const split = parsePct(splitText);

  const submit = async () => {
    if (!name.trim()) { toast('Name is required.'); return; }
    if (!fullName.trim() || !email.trim()) { toast("The owner's name and email are required."); return; }
    if (password.length < 8) { toast('Password must be at least 8 characters.'); return; }
    if (Number.isNaN(split)) { toast('Share must be 0–100.'); return; }
    if (country && !/^[A-Za-z]{2}$/.test(country)) { toast('Country is a 2-letter code.'); return; }
    setIsSaving(true);
    try {
      await onSubmit({
        email: email.trim(), fullName: fullName.trim(), password,
        name: name.trim(),
        ...(country ? { country } : {}),
        revenueSplitPct: split,
      }, assigned);
    } catch (err) {
      toast(err instanceof Error ? err.message : `Could not add the ${labels.account.toLowerCase()}.`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Add ${labels.account.toLowerCase()}`} subtitle="Creates the account and the login of the person who owns it.">
      <div className="form-row">
        <div className="field">
          <label htmlFor="account-name">{labels.account} name</label>
          <input id="account-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="account-country">Country</label>
          <input id="account-country" type="text" maxLength={2} placeholder="e.g. ES" value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())} />
        </div>
      </div>
      <div className="sechead">Login details</div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="owner-name">Full name</label>
          <input id="owner-name" type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="owner-email">Email</label>
          <input id="owner-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="owner-password">Password</label>
        <input id="owner-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <p className="sub">At least 8 characters. Ignored if this email already has a login.</p>
      </div>
      <div className="field">
        <label htmlFor="account-split">{labels.account} share of distributable</label>
        <div className="pct-input">
          <input id="account-split" type="number" min={0} max={100} value={splitText} aria-invalid={Number.isNaN(split) || undefined}
            onChange={(e) => setSplitText(e.target.value)} />
          <span className="sub">%</span>
        </div>
      </div>
      <div className="field" role="group" aria-labelledby="assign-agents-label">
        <div className="field-label" id="assign-agents-label">Assign {labels.agents.toLowerCase()}</div>
        <div className="check-list">
          {agents.length === 0 ? <span className="sub">No {labels.agents.toLowerCase()} in this workspace yet.</span>
            : agents.map((ag) => (
              <label key={ag.id} className="check-row">
                <input type="checkbox" checked={assigned.includes(ag.id)}
                  onChange={(e) => setAssigned((prev) => e.target.checked ? [...prev, ag.id] : prev.filter((id) => id !== ag.id))} />
                <span>{ag.name}</span>
              </label>
            ))}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={submit} disabled={isSaving}>{isSaving ? 'Adding…' : `Add ${labels.account.toLowerCase()}`}</button>
      </div>
    </Modal>
  );
}

interface EditAccountModalProps {
  account: Account;
  agents: { id: string; name: string }[];
  canEditSplits: boolean;
  onClose: () => void;
  onSubmit: (input: UpdateAccountInput, agentIds: string[]) => Promise<void>;
}

/**
 * Everything about one creator in a single dialog: its details, what it is
 * paid, and which agents work it — who is assigned is what decides what an
 * agent sees, so it belongs with the rest, not behind a second button.
 */
function EditAccountModal({ account, agents, canEditSplits, onClose, onSubmit }: EditAccountModalProps) {
  const { labels } = useCurrentSession();
  const detail = useAccountDetail(account.id);

  return (
    <Modal open onClose={onClose} title={`Edit ${account.name}`}
      subtitle="Changing the share only affects sales posted from now on; the ledger keeps what it already recorded.">
      {detail.isError ? <p className="sub">Couldn't load this {labels.account.toLowerCase()}.</p>
        : !detail.data ? <p className="sub">Loading…</p>
          : (
            <EditAccountForm
              account={account}
              agents={agents}
              assigned={detail.data.agents?.map((a) => a.agentId) ?? []}
              canEditSplits={canEditSplits}
              onClose={onClose}
              onSubmit={onSubmit}
            />
          )}
    </Modal>
  );
}

// Mounted only once the roster is known, so every field seeds from a prop
// instead of syncing itself in an effect.
function EditAccountForm({ account, agents, assigned: initialAssigned, canEditSplits, onClose, onSubmit }: {
  account: Account;
  agents: { id: string; name: string }[];
  assigned: string[];
  canEditSplits: boolean;
  onClose: () => void;
  onSubmit: (input: UpdateAccountInput, agentIds: string[]) => Promise<void>;
}) {
  const { labels } = useCurrentSession();
  const [name, setName] = useState(account.name);
  const [country, setCountry] = useState(account.country ?? '');
  const [splitText, setSplitText] = useState(account.revenueSplitPct === undefined ? '' : String(account.revenueSplitPct));
  const [assigned, setAssigned] = useState(initialAssigned);
  const [isSaving, setIsSaving] = useState(false);
  const split = parsePct(splitText);
  const splitInvalid = canEditSplits && Number.isNaN(split);

  const submit = async () => {
    if (!name.trim()) { toast('Name is required.'); return; }
    if (splitInvalid) { toast('Share must be 0–100.'); return; }
    if (country && !/^[A-Za-z]{2}$/.test(country)) { toast('Country is a 2-letter code.'); return; }
    setIsSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        country: country.trim(),
        ...(canEditSplits ? { revenueSplitPct: split } : {}),
      }, assigned);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="form-row">
        <div className="field">
          <label htmlFor="edit-account-name">Name</label>
          <input id="edit-account-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="edit-account-country">Country</label>
          <input id="edit-account-country" type="text" maxLength={2} placeholder="e.g. ES" value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())} />
        </div>
      </div>
      {/* Renaming is accounts.manage; changing what it is paid is a revenue
          decision, so without that permission the field is absent, not dead. */}
      {canEditSplits && (
        <div className="field">
          <label htmlFor="edit-account-split">{labels.account} share of distributable</label>
          <div className="pct-input">
            <input id="edit-account-split" type="number" min={0} max={100} value={splitText}
              aria-invalid={splitInvalid || undefined} onChange={(e) => setSplitText(e.target.value)} />
            <span className="sub">%</span>
          </div>
          <p className="sub">
            {splitInvalid ? <span className="text-neg">0–100 only</span> : `Agency keeps ${100 - split}%.`}
          </p>
        </div>
      )}
      <div className="field" role="group" aria-labelledby="edit-agents-label">
        <div className="field-label" id="edit-agents-label">Assigned {labels.agents.toLowerCase()}</div>
        <p className="sub">An assigned {labels.agent.toLowerCase()} can create links for this {labels.account.toLowerCase()} and sees its payments.</p>
        <div className="check-list">
          {agents.length === 0 ? <span className="sub">No {labels.agents.toLowerCase()} in this workspace yet.</span>
            : agents.map((ag) => (
              <label key={ag.id} className="check-row">
                <input type="checkbox" checked={assigned.includes(ag.id)}
                  onChange={(e) => setAssigned(e.target.checked ? [...assigned, ag.id] : assigned.filter((id) => id !== ag.id))} />
                <span>{ag.name}</span>
              </label>
            ))}
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn" disabled={isSaving || splitInvalid}>{isSaving ? 'Saving…' : 'Save changes'}</button>
      </div>
    </form>
  );
}
