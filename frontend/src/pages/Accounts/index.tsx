import { useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { initials } from '../../lib/format';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { PageHeader, Money, Pill, EmptyState, FilterBar, LoadingCard, ErrorCard } from '../../components/ui';
import {
  REVENUE_MODEL_LABELS, ACCOUNT_STATUS_LABELS, canTakeLinks,
  type Account, type AccountStatus, type RevenueModel,
} from '../../api/endpoints';
import { useAccountsData } from './useAccountsData';

const DEFAULT_SPLIT_PCT = 70;

/** An account whose pay deal was sent — i.e. the caller sees the whole workspace. */
type AccountWithTerms = Account & { revenueModel: RevenueModel };
const hasTerms = (a: Account): a is AccountWithTerms => a.revenueModel !== undefined;

const STATUS_TONE: Record<AccountStatus, 'ok' | 'warn' | 'muted'> = {
  active: 'ok',
  onboarding: 'warn',
  paused: 'muted',
  archived: 'muted',
};

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/** NaN for anything that isn't a usable percentage, so callers can flag it. */
function parsePct(text: string): number {
  const n = parseFloat(text);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : Number.NaN;
}

export default function AccountsPage() {
  const can = useCan();
  const { accounts, agents, isLoading, isError, createAccount, updateAccount } = useAccountsData();
  const canManage = can('accounts.manage');
  const canViewSplits = can('commissions.view');
  const canEditSplits = can('commissions.manage');

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [model, setModel] = useState<RevenueModel>('revshare');
  const [splitText, setSplitText] = useState(String(DEFAULT_SPLIT_PCT));
  const [salaryText, setSalaryText] = useState('');
  const [salaryIncreaseText, setSalaryIncreaseText] = useState('');
  const [assigned, setAssigned] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Raw text, not numbers: parsing on every keystroke turns a cleared field
  // into 0 and makes the box impossible to retype.
  const [splitEdits, setSplitEdits] = useState<Record<string, string>>({});
  const [isSavingSplits, setIsSavingSplits] = useState(false);
  const [pausing, setPausing] = useState<Account | null>(null);
  const [isPausing, setIsPausing] = useState(false);
  const [search, setSearch] = useState('');

  const resetForm = () => {
    setName(''); setHandle(''); setModel('revshare');
    setSplitText(String(DEFAULT_SPLIT_PCT)); setSalaryText(''); setSalaryIncreaseText('');
    setAssigned([]);
  };

  const closeCreate = () => { setCreateOpen(false); resetForm(); };

  const submitCreate = async () => {
    if (!name.trim()) { toast('Name is required.'); return; }
    const cleanHandle = handle.trim();
    setIsSaving(true);
    try {
      await createAccount({
        stageName: name.trim(),
        handle: cleanHandle ? (cleanHandle.startsWith('@') ? cleanHandle : `@${cleanHandle}`) : undefined,
        revenueModel: model,
        revenueSplitPct: model === 'revshare' ? clampPct(parseFloat(splitText) || 0) : 0,
        salary: model === 'salary' ? parseFloat(salaryText) || 0 : undefined,
        salaryIncreasePct: model === 'salary' && salaryIncreaseText ? parseFloat(salaryIncreaseText) || 0 : undefined,
      }, assigned);
      closeCreate();
      toast('Account added.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the account.');
    } finally {
      setIsSaving(false);
    }
  };

  // Activating is harmless; pausing stops every new link for the account, so
  // only that direction is confirmed.
  const requestStatusChange = (c: Account) => {
    if (canTakeLinks(c.status)) { setPausing(c); return; }
    void applyStatus(c, 'active');
  };

  const applyStatus = async (c: Account, status: AccountStatus) => {
    setIsPausing(true);
    try {
      await updateAccount(c.id, { status });
      setPausing(null);
      toast(status === 'active' ? `${c.stageName} activated.` : `${c.stageName} paused. No new links.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the account.');
    } finally {
      setIsPausing(false);
    }
  };

  const saveSplits = async () => {
    const dirty = Object.entries(splitEdits);
    if (dirty.length === 0) return;
    setIsSavingSplits(true);
    // allSettled, not all: one rejected update must not strand the rows that
    // did save, or the table keeps offering to re-save them.
    const results = await Promise.allSettled(
      dirty.map(([id, text]) => updateAccount(id, { revenueSplitPct: clampPct(parsePct(text)) })),
    );
    setIsSavingSplits(false);

    const failed = dirty.filter((_, i) => results[i].status === 'rejected').map(([id]) => id);
    setSplitEdits(Object.fromEntries(failed.map((id) => [id, splitEdits[id]])));
    toast(failed.length === 0
      ? 'Account splits saved.'
      : `Saved ${dirty.length - failed.length} of ${dirty.length}. Try the rest again.`);
  };

  const query = search.trim().toLowerCase();
  const visibleAccounts = query
    ? accounts.filter((c) => `${c.stageName} ${c.handle ?? ''}`.toLowerCase().includes(query))
    : accounts;

  // The terms are the account's deal with the agency. The server omits them for
  // anyone without workspace scope, so these render nothing rather than
  // reconstructing the agency's share from a missing number.
  const modelSummary = (c: Account) => {
    if (c.revenueModel === undefined) return null;
    if (c.revenueModel === 'revshare') {
      return c.revenueSplitPct === undefined
        ? null
        : `${c.revenueSplitPct}% account / ${100 - c.revenueSplitPct}% agency`;
    }
    if (c.revenueModel === 'salary') return <><Money amount={c.salary ?? 0} /> / month</>;
    return 'No account payout';
  };

  return (
    <div>
      <PageHeader
        eyebrow="People"
        title="Accounts"
        subtitle="Accounts operating under this workspace."
        actions={canManage ? <button className="btn" onClick={() => setCreateOpen(true)}>Add account</button> : null}
      />

      {accounts.length > 0 && (
        <FilterBar>
          <input
            type="search" className="search-input" aria-label="Search accounts"
            placeholder="Search name or handle" value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="sub">{visibleAccounts.length} of {accounts.length}</span>
        </FilterBar>
      )}

      {isLoading ? <LoadingCard label="Loading accounts…" />
        : isError ? <ErrorCard message="Couldn't load accounts." />
        : accounts.length === 0 ? (
          <div className="card">
            <EmptyState
              title="No accounts yet."
              hint={canManage ? 'Add the first account to start generating links.' : 'Ask an admin to add one.'}
            />
          </div>
        ) : visibleAccounts.length === 0 ? (
          <div className="card">
            <EmptyState title="No accounts match that search." hint="Clear the search to see them all." />
          </div>
        ) : (
          <div className="grid">
            {visibleAccounts.map((c) => (
              <div key={c.id} className="card ws">
                <div className="ws-top">
                  <div className="ws-mark">{initials(c.stageName)}</div>
                  <div className="grow">
                    <div className="ws-name">{c.stageName}</div>
                    <div className="ws-meta">{c.handle ?? '—'}</div>
                  </div>
                  {canManage && (
                    <button className="btn ghost small" onClick={() => requestStatusChange(c)}>
                      {canTakeLinks(c.status) ? 'Pause' : 'Activate'}
                    </button>
                  )}
                </div>
                <div>
                  <div className="ws-row">
                    <span>Status</span>
                    <Pill tone={STATUS_TONE[c.status]}>{ACCOUNT_STATUS_LABELS[c.status]}</Pill>
                  </div>
                  {c.revenueModel && (
                    <div className="ws-row"><span>Model</span><span>{REVENUE_MODEL_LABELS[c.revenueModel]}</span></div>
                  )}
                  {modelSummary(c) && (
                    <div className="ws-row"><span>Terms</span><span>{modelSummary(c)}</span></div>
                  )}
                  {c.agentsAssigned !== undefined && (
                    <div className="ws-row"><span>Agents assigned</span><span className="mono">{c.agentsAssigned}</span></div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

      {canViewSplits && accounts.length > 0 && (
        <div className="card section">
          <div className="sechead">Account revenue splits <span className="sechead-note">share of distributable, per account</span></div>
          <div className="tablewrap flush">
            <table>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Model</th>
                  <th scope="col">Account share</th>
                  <th scope="col">Agency share</th>
                </tr>
              </thead>
              <tbody>
                {/* This table is only about terms, so an account whose terms
                    were withheld has no row here. */}
                {accounts.filter(hasTerms).map((c) => {
                  if (c.revenueModel !== 'revshare') {
                    return (
                      <tr key={c.id}>
                        <td className="cname">{c.stageName}</td>
                        <td><Pill>{REVENUE_MODEL_LABELS[c.revenueModel]}</Pill></td>
                        <td colSpan={2} className="sub">
                          {c.revenueModel === 'salary'
                            ? <>Fixed <Money amount={c.salary ?? 0} /> per month, no per-sale split</>
                            : 'Agency keeps the distributable amount'}
                        </td>
                      </tr>
                    );
                  }
                  const text = splitEdits[c.id] ?? String(c.revenueSplitPct);
                  const pct = parsePct(text);
                  return (
                    <tr key={c.id}>
                      <td className="cname">{c.stageName}</td>
                      <td><Pill>{REVENUE_MODEL_LABELS.revshare}</Pill></td>
                      <td>
                        <div className="pct-input">
                          <input
                            type="number" min={0} max={100} value={text}
                            aria-label={`${c.stageName} account share, percent`}
                            aria-invalid={Number.isNaN(pct)}
                            disabled={!canEditSplits}
                            onChange={(e) => setSplitEdits((prev) => ({ ...prev, [c.id]: e.target.value }))}
                          />
                          <span className="sub">%</span>
                        </div>
                      </td>
                      <td className="mono">
                        {Number.isNaN(pct)
                          ? <span className="text-neg">0–100 only</span>
                          : `${100 - pct}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {canEditSplits && (
            <div className="actions-right">
              <button
                className="btn"
                onClick={saveSplits}
                disabled={
                  isSavingSplits
                  || Object.keys(splitEdits).length === 0
                  || Object.values(splitEdits).some((t) => Number.isNaN(parsePct(t)))
                }
              >
                {isSavingSplits ? 'Saving…' : 'Save splits'}
              </button>
            </div>
          )}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={closeCreate}
        title="Add account"
        subtitle="An account operating under this workspace."
      >
        <div className="field">
          <label htmlFor="account-name">Name</label>
          <input id="account-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="account-handle">Handle</label>
          <input id="account-handle" type="text" placeholder="@handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="account-model">Revenue model</label>
          <select id="account-model" value={model} onChange={(e) => setModel(e.target.value as RevenueModel)}>
            {(Object.keys(REVENUE_MODEL_LABELS) as RevenueModel[]).map((m) => (
              <option key={m} value={m}>{REVENUE_MODEL_LABELS[m]}</option>
            ))}
          </select>
        </div>
        {model === 'revshare' && (
          <div className="field">
            <label htmlFor="account-split">Account share of distributable</label>
            <div className="pct-input">
              <input id="account-split" type="number" min={0} max={100} value={splitText} onChange={(e) => setSplitText(e.target.value)} />
              <span className="sub">%</span>
            </div>
          </div>
        )}
        {model === 'salary' && (
          <>
            <div className="field">
              <label htmlFor="account-salary">Monthly salary</label>
              <input id="account-salary" type="number" min={0} step={0.01} value={salaryText} onChange={(e) => setSalaryText(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="account-increase">Automatic monthly increase (%)</label>
              <input id="account-increase" type="number" min={0} placeholder="0" value={salaryIncreaseText} onChange={(e) => setSalaryIncreaseText(e.target.value)} />
            </div>
          </>
        )}
        {model === 'ai' && <p className="sub">AI accounts have no payout. The agency keeps the distributable amount.</p>}
        <div className="field" role="group" aria-labelledby="assign-agents-label">
          <div className="field-label" id="assign-agents-label">Assign agents</div>
          <div className="check-list">
            {agents.length === 0 ? (
              <span className="sub">No agents in this workspace yet.</span>
            ) : agents.map((ch) => (
              <label key={ch.membershipId} className="check-row">
                <input
                  type="checkbox"
                  checked={assigned.includes(ch.membershipId)}
                  onChange={(e) => setAssigned((prev) =>
                    e.target.checked ? [...prev, ch.membershipId] : prev.filter((id) => id !== ch.membershipId))}
                />
                <span>{ch.name}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={closeCreate}>Cancel</button>
          <button className="btn" onClick={submitCreate} disabled={isSaving}>{isSaving ? 'Adding…' : 'Add account'}</button>
        </div>
      </Modal>

      <Modal
        open={pausing !== null}
        onClose={() => setPausing(null)}
        title={pausing ? `Pause ${pausing.stageName}?` : ''}
        subtitle="No new payment links can be created for this account. Links already out there keep working, and nothing changes in the ledger."
      >
        {pausing && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setPausing(null)}>Keep active</button>
            <button className="btn" disabled={isPausing} onClick={() => applyStatus(pausing, 'paused')}>
              {isPausing ? 'Pausing…' : 'Pause account'}
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
