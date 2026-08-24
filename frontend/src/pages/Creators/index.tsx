import { useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { initials } from '../../lib/format';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { PageHeader, Money, Pill, EmptyState, LoadingCard, ErrorCard } from '../../components/ui';
import {
  REVENUE_MODEL_LABELS, CREATOR_STATUS_LABELS, canTakeLinks,
  type Creator, type CreatorStatus, type RevenueModel,
} from '../../api/endpoints';
import { useCreatorsData } from './useCreatorsData';

const DEFAULT_SPLIT_PCT = 70;

const STATUS_TONE: Record<CreatorStatus, 'ok' | 'warn' | 'muted'> = {
  active: 'ok',
  onboarding: 'warn',
  paused: 'muted',
  archived: 'muted',
};

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

export default function CreatorsPage() {
  const can = useCan();
  const { creators, chatters, isLoading, isError, createCreator, updateCreator } = useCreatorsData();
  const canManage = can('creators.manage');
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

  const [splitEdits, setSplitEdits] = useState<Record<string, number>>({});

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
      await createCreator({
        stageName: name.trim(),
        handle: cleanHandle ? (cleanHandle.startsWith('@') ? cleanHandle : `@${cleanHandle}`) : undefined,
        revenueModel: model,
        revenueSplitPct: model === 'revshare' ? clampPct(parseFloat(splitText) || 0) : 0,
        salary: model === 'salary' ? parseFloat(salaryText) || 0 : undefined,
        salaryIncreasePct: model === 'salary' && salaryIncreaseText ? parseFloat(salaryIncreaseText) || 0 : undefined,
      }, assigned);
      closeCreate();
      toast('Creator added.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the creator.');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleStatus = async (c: Creator) => {
    const status: CreatorStatus = canTakeLinks(c.status) ? 'paused' : 'active';
    try {
      await updateCreator(c.id, { status });
      toast(status === 'active' ? `${c.stageName} activated.` : `${c.stageName} paused. No new links.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the creator.');
    }
  };

  const saveSplits = async () => {
    const dirty = Object.entries(splitEdits);
    if (dirty.length === 0) return;
    try {
      await Promise.all(dirty.map(([id, pct]) => updateCreator(id, { revenueSplitPct: clampPct(pct) })));
      setSplitEdits({});
      toast('Creator splits saved.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the splits.');
    }
  };

  const modelSummary = (c: Creator) => {
    if (c.revenueModel === 'revshare') return `${c.revenueSplitPct}% creator / ${100 - c.revenueSplitPct}% agency`;
    if (c.revenueModel === 'salary') return <><Money amount={c.salary ?? 0} /> / month</>;
    return 'No creator payout';
  };

  return (
    <div>
      <PageHeader
        eyebrow="People"
        title="Creators"
        subtitle="Content creators operating under this workspace."
        actions={canManage ? <button className="btn" onClick={() => setCreateOpen(true)}>Add creator</button> : null}
      />

      {isLoading ? <LoadingCard label="Loading creators…" />
        : isError ? <ErrorCard message="Couldn't load creators." />
        : creators.length === 0 ? (
          <div className="card">
            <EmptyState
              title="No creators yet."
              hint={canManage ? 'Add the first creator to start generating links.' : 'Ask an admin to add one.'}
            />
          </div>
        ) : (
          <div className="grid">
            {creators.map((c) => (
              <div key={c.id} className="card ws">
                <div className="ws-top">
                  <div className="ws-mark">{initials(c.stageName)}</div>
                  <div className="grow">
                    <div className="ws-name">{c.stageName}</div>
                    <div className="ws-meta">{c.handle ?? '—'}</div>
                  </div>
                  {canManage && (
                    <button className="btn ghost small" onClick={() => toggleStatus(c)}>
                      {canTakeLinks(c.status) ? 'Pause' : 'Activate'}
                    </button>
                  )}
                </div>
                <div>
                  <div className="ws-row">
                    <span>Status</span>
                    <Pill tone={STATUS_TONE[c.status]}>{CREATOR_STATUS_LABELS[c.status]}</Pill>
                  </div>
                  <div className="ws-row"><span>Model</span><span>{REVENUE_MODEL_LABELS[c.revenueModel]}</span></div>
                  <div className="ws-row"><span>Terms</span><span>{modelSummary(c)}</span></div>
                  <div className="ws-row"><span>Chatters assigned</span><span className="mono">{c.chattersAssigned}</span></div>
                </div>
              </div>
            ))}
          </div>
        )}

      {canViewSplits && creators.length > 0 && (
        <div className="card section">
          <div className="sechead">Creator revenue splits <span className="sechead-note">share of distributable, per creator</span></div>
          <div className="tablewrap flush">
            <table>
              <thead>
                <tr><th>Creator</th><th>Model</th><th>Creator share</th><th>Agency share</th></tr>
              </thead>
              <tbody>
                {creators.map((c) => {
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
                  const value = splitEdits[c.id] ?? c.revenueSplitPct;
                  return (
                    <tr key={c.id}>
                      <td className="cname">{c.stageName}</td>
                      <td><Pill>{REVENUE_MODEL_LABELS.revshare}</Pill></td>
                      <td>
                        <div className="pct-input">
                          <input
                            type="number" min={0} max={100} value={value}
                            disabled={!canEditSplits}
                            onChange={(e) => setSplitEdits((prev) => ({ ...prev, [c.id]: parseFloat(e.target.value) || 0 }))}
                          />
                          <span className="sub">%</span>
                        </div>
                      </td>
                      <td className="mono">{100 - clampPct(value)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {canEditSplits && (
            <div className="actions-right">
              <button className="btn" onClick={saveSplits} disabled={Object.keys(splitEdits).length === 0}>Save splits</button>
            </div>
          )}
        </div>
      )}

      <Modal open={createOpen} onClose={closeCreate}>
        <h3>Add creator</h3>
        <p className="sub">A content creator operating under this workspace.</p>
        <div className="field">
          <label htmlFor="creator-name">Name</label>
          <input id="creator-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="creator-handle">Handle</label>
          <input id="creator-handle" type="text" placeholder="@handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="creator-model">Revenue model</label>
          <select id="creator-model" value={model} onChange={(e) => setModel(e.target.value as RevenueModel)}>
            {(Object.keys(REVENUE_MODEL_LABELS) as RevenueModel[]).map((m) => (
              <option key={m} value={m}>{REVENUE_MODEL_LABELS[m]}</option>
            ))}
          </select>
        </div>
        {model === 'revshare' && (
          <div className="field">
            <label htmlFor="creator-split">Creator share of distributable</label>
            <div className="pct-input">
              <input id="creator-split" type="number" min={0} max={100} value={splitText} onChange={(e) => setSplitText(e.target.value)} />
              <span className="sub">%</span>
            </div>
          </div>
        )}
        {model === 'salary' && (
          <>
            <div className="field">
              <label htmlFor="creator-salary">Monthly salary</label>
              <input id="creator-salary" type="number" min={0} step={0.01} value={salaryText} onChange={(e) => setSalaryText(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="creator-increase">Automatic monthly increase (%)</label>
              <input id="creator-increase" type="number" min={0} placeholder="0" value={salaryIncreaseText} onChange={(e) => setSalaryIncreaseText(e.target.value)} />
            </div>
          </>
        )}
        {model === 'ai' && <p className="sub">AI creators have no payout. The agency keeps the distributable amount.</p>}
        <div className="field">
          <label>Assign chatters</label>
          <div className="check-list">
            {chatters.length === 0 ? (
              <span className="sub">No chatters in this workspace yet.</span>
            ) : chatters.map((ch) => (
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
          <button className="btn" onClick={submitCreate} disabled={isSaving}>{isSaving ? 'Adding…' : 'Add creator'}</button>
        </div>
      </Modal>
    </div>
  );
}
