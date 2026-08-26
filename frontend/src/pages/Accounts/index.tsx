import { useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import { initials } from '../../lib/format';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { PageHeader, Pill, EmptyState, FilterBar, LoadingCard, ErrorCard } from '../../components/ui';
import { ACCOUNT_STATUS_LABELS, type Account, type AccountStatus } from '../../api/endpoints';
import { useAccountsData, useAccountDetail } from './useAccountsData';

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
  const [assigning, setAssigning] = useState<Account | null>(null);
  const [pausing, setPausing] = useState<Account | null>(null);
  const [isPausing, setIsPausing] = useState(false);
  const [search, setSearch] = useState('');

  useUnsavedChanges('account-edit', editing !== null || createOpen);

  // Activating is harmless; pausing stops every new link, so only that
  // direction is confirmed.
  const requestStatusChange = (a: Account) => {
    if (a.status === 'active') { setPausing(a); return; }
    void applyStatus(a, 'active');
  };

  const applyStatus = async (a: Account, status: AccountStatus) => {
    setIsPausing(true);
    try {
      await updateAccount(a.id, { status });
      setPausing(null);
      toast(status === 'active' ? `${a.name} activated.` : `${a.name} paused. No new links.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : `Could not update the ${labels.account.toLowerCase()}.`);
    } finally {
      setIsPausing(false);
    }
  };

  const query = search.trim().toLowerCase();
  const visible = query
    ? accounts.filter((a) => `${a.name} ${a.handle ?? ''} ${a.ownerName} ${a.ownerEmail}`.toLowerCase().includes(query))
    : accounts;

  return (
    <div>
      <PageHeader
        title={labels.accounts}
        subtitle={`${labels.accounts} operating under this workspace. Each one has an owner who can sign in.`}
        actions={canManage ? <button className="btn" onClick={() => setCreateOpen(true)}>Add {labels.account.toLowerCase()}</button> : null}
      />

      {accounts.length > 0 && (
        <FilterBar>
          <input type="search" className="search-input" aria-label={`Search ${labels.accounts}`}
            placeholder="Search name, handle or owner" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="sub">{visible.length} of {accounts.length}</span>
        </FilterBar>
      )}

      {isLoading ? <LoadingCard label={`Loading ${labels.accounts.toLowerCase()}…`} />
        : isError ? <ErrorCard message={`Couldn't load ${labels.accounts.toLowerCase()}.`} />
        : accounts.length === 0 ? (
          <div className="card">
            <EmptyState title={`No ${labels.accounts.toLowerCase()} yet.`}
              hint={canManage ? 'Add the first one to start generating links.' : 'Ask an admin to add one.'} />
          </div>
        ) : visible.length === 0 ? (
          <div className="card"><EmptyState title="Nothing matches that search." hint="Clear the search to see them all." /></div>
        ) : (
          <div className="grid">
            {visible.map((a) => (
              <div key={a.id} className="card ws">
                <div className="ws-top">
                  <div className="ws-mark">{initials(a.name)}</div>
                  <div className="grow">
                    <div className="ws-name">{a.name}</div>
                    <div className="ws-meta">{a.handle ?? a.ownerEmail}</div>
                  </div>
                  {canManage && (
                    <div className="controls">
                      <button className="btn ghost small" onClick={() => setEditing(a)}>Edit</button>
                      <button className="btn ghost small" onClick={() => setAssigning(a)}>{labels.agents}</button>
                      <button className="btn ghost small" onClick={() => requestStatusChange(a)}>
                        {a.status === 'active' ? 'Pause' : 'Activate'}
                      </button>
                    </div>
                  )}
                </div>
                <div>
                  <div className="ws-row"><span>Status</span><Pill tone={STATUS_TONE[a.status]}>{ACCOUNT_STATUS_LABELS[a.status]}</Pill></div>
                  <div className="ws-row"><span>Owner</span><span>{a.ownerName}</span></div>
                  {canViewSplits && a.revenueSplitPct !== undefined && (
                    <>
                      <div className="ws-row"><span>{labels.account} share</span><span className="mono">{a.revenueSplitPct}%</span></div>
                      <div className="ws-row"><span>Agency share</span><span className="mono">{100 - a.revenueSplitPct}%</span></div>
                    </>
                  )}
                  {a.agentsAssigned !== undefined && (
                    <div className="ws-row"><span>{labels.agents} assigned</span><span className="mono">{a.agentsAssigned}</span></div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

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
          canEditSplits={canEditSplits}
          onClose={() => setEditing(null)}
          onSubmit={async (input) => {
            await updateAccount(editing.id, input);
            setEditing(null);
            toast(`${labels.account} updated.`);
          }}
        />
      )}

      {assigning && (
        <AssignAgentsModal
          account={assigning}
          agents={agents}
          onClose={() => setAssigning(null)}
          onSubmit={async (agentIds) => {
            await setAssignedAgents(assigning, agentIds);
            setAssigning(null);
            toast('Assignments saved.');
          }}
        />
      )}

      <Modal open={pausing !== null} onClose={() => setPausing(null)} title={pausing ? `Pause ${pausing.name}?` : ''}
        subtitle="No new payment links can be created. Links already out there keep working, and nothing changes in the ledger.">
        {pausing && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setPausing(null)}>Keep active</button>
            <button className="btn" disabled={isPausing} onClick={() => applyStatus(pausing, 'paused')}>{isPausing ? 'Pausing…' : 'Pause'}</button>
          </div>
        )}
      </Modal>
    </div>
  );
}

interface CreateAccountModalProps {
  agents: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: (input: { email: string; fullName: string; password: string; name: string; handle?: string; revenueSplitPct: number }, agentIds: string[]) => Promise<void>;
}

/** An account and the login of the person who owns it, in one form. */
function CreateAccountModal({ agents, onClose, onSubmit }: CreateAccountModalProps) {
  const { labels } = useCurrentSession();
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
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
    const cleanHandle = handle.trim();
    setIsSaving(true);
    try {
      await onSubmit({
        email: email.trim(), fullName: fullName.trim(), password,
        name: name.trim(),
        handle: cleanHandle ? (cleanHandle.startsWith('@') ? cleanHandle : `@${cleanHandle}`) : undefined,
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
          <label htmlFor="account-handle">Handle</label>
          <input id="account-handle" type="text" placeholder="@handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
        </div>
      </div>
      <div className="sechead">Owner login</div>
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
  canEditSplits: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; handle: string; revenueSplitPct?: number }) => Promise<void>;
}

function EditAccountModal({ account, canEditSplits, onClose, onSubmit }: EditAccountModalProps) {
  const { labels } = useCurrentSession();
  const [name, setName] = useState(account.name);
  const [handle, setHandle] = useState(account.handle ?? '');
  const [splitText, setSplitText] = useState(account.revenueSplitPct === undefined ? '' : String(account.revenueSplitPct));
  const [isSaving, setIsSaving] = useState(false);
  const split = parsePct(splitText);
  const splitInvalid = canEditSplits && Number.isNaN(split);

  const submit = async () => {
    if (!name.trim()) { toast('Name is required.'); return; }
    if (splitInvalid) { toast('Share must be 0–100.'); return; }
    const cleanHandle = handle.trim();
    setIsSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        handle: cleanHandle ? (cleanHandle.startsWith('@') ? cleanHandle : `@${cleanHandle}`) : '',
        ...(canEditSplits ? { revenueSplitPct: split } : {}),
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Edit ${account.name}`}
      subtitle="Changing the share only affects sales posted from now on; the ledger keeps what it already recorded.">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="field">
          <label htmlFor="edit-account-name">Name</label>
          <input id="edit-account-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="edit-account-handle">Handle</label>
          <input id="edit-account-handle" type="text" placeholder="@handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="edit-account-split">{labels.account} share of distributable</label>
          <div className="pct-input">
            <input id="edit-account-split" type="number" min={0} max={100} value={splitText} aria-invalid={splitInvalid || undefined}
              // Renaming is accounts.manage; changing what it is paid is a revenue decision.
              disabled={!canEditSplits} onChange={(e) => setSplitText(e.target.value)} />
            <span className="sub">%</span>
          </div>
          <p className="sub">
            {splitInvalid ? <span className="text-neg">0–100 only</span>
              : !canEditSplits ? 'You can rename this account but not change its share.'
                : `Agency keeps ${100 - split}%.`}
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={isSaving || splitInvalid}>{isSaving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
  );
}

interface AssignAgentsModalProps {
  account: Account;
  agents: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: (agentIds: string[]) => Promise<void>;
}

/** Which agents work this account. This is what decides what an agent sees. */
function AssignAgentsModal({ account, agents, onClose, onSubmit }: AssignAgentsModalProps) {
  const { labels } = useCurrentSession();
  const detail = useAccountDetail(account.id);

  return (
    <Modal open onClose={onClose} title={`${labels.agents} for ${account.name}`}
      subtitle={`An assigned ${labels.agent.toLowerCase()} can create links for this ${labels.account.toLowerCase()} and sees its payments.`}>
      {detail.isError ? <p className="sub">Couldn't load the current roster.</p>
        : !detail.data ? <p className="sub">Loading…</p>
          : <AgentChecklist initial={detail.data.agents?.map((a) => a.agentId) ?? []} agents={agents} onClose={onClose} onSubmit={onSubmit} />}
    </Modal>
  );
}

// Mounted only once the roster is known, so the checklist can seed its state
// from a prop instead of syncing it in an effect.
function AgentChecklist({ initial, agents, onClose, onSubmit }: {
  initial: string[];
  agents: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: (agentIds: string[]) => Promise<void>;
}) {
  const { labels } = useCurrentSession();
  const [assigned, setAssigned] = useState(initial);
  const [isSaving, setIsSaving] = useState(false);

  const submit = async () => {
    setIsSaving(true);
    try { await onSubmit(assigned); }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not save assignments.'); }
    finally { setIsSaving(false); }
  };

  return (
    <>
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
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={submit} disabled={isSaving}>{isSaving ? 'Saving…' : 'Save'}</button>
      </div>
    </>
  );
}
