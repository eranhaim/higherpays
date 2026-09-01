import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PageHeader, Pill, DataTable, Money, DateCell, EmptyState, LoadingCard, ErrorCard, StatCard, StatGrid,
  Select, type Column,
} from '../../components/ui';
import type { PlatformWorkspace, OnboardAgencyInput, PlatformFeeRate } from '../../api/endpoints';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { usePlatformData } from './usePlatformData';

const CURRENCIES = ['EUR'];

/** NaN for anything that isn't a usable percentage, so callers can flag it. */
function parsePct(text: string): number {
  const n = parseFloat(text);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : Number.NaN;
}
function parseAmount(text: string): number {
  const n = parseFloat(text || '0');
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

/**
 * The operator console: every agency, not one of them. Access comes from
 * `users.is_platform_admin`, a tier above workspace roles — so this page sits
 * outside the workspace layout and is gated on its own check.
 */
export default function PlatformPage() {
  const {
    isCheckingAccess, isPlatformAdmin, overview, workspaces, isLoading, isError,
    onboardAgency, setStatus, setPlatformFee,
  } = usePlatformData();
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [editingFee, setEditingFee] = useState<PlatformWorkspace | null>(null);
  const [suspending, setSuspending] = useState<PlatformWorkspace | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const changeStatus = async (w: PlatformWorkspace, status: 'active' | 'suspended') => {
    setIsBusy(true);
    try {
      await setStatus(w.id, status);
      setSuspending(null);
      toast(status === 'active' ? `${w.name} is active again.` : `${w.name} suspended.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the status.');
    } finally {
      setIsBusy(false);
    }
  };

  const columns: Column<PlatformWorkspace>[] = [
    { key: 'name', header: 'Agency', render: (w) => <span className="cname">{w.name}</span> },
    { key: 'status', header: 'Status', render: (w) => <Pill tone={w.status === 'active' ? 'ok' : 'muted'}>{w.status}</Pill> },
    { key: 'currency', header: 'Currency', render: (w) => <span className="mono">{w.currency}</span> },
    { key: 'merchant', header: 'Merchant ID', render: (w) => w.merchantId ? <span className="mono">{w.merchantId}</span> : <span className="sub">default</span> },
    { key: 'rate', header: 'Blended rate', align: 'right', render: (w) => <span className="mono">{w.blendedRatePct}%</span> },
    { key: 'members', header: 'Members', align: 'right', render: (w) => <span className="mono">{w.members}</span> },
    { key: 'paid', header: 'Paid', align: 'right', render: (w) => <span className="mono">{w.paidPayments}</span> },
    { key: 'volume', header: 'Gross volume', align: 'right', render: (w) => <Money amount={w.grossVolume} currency={w.currency} direction="in" /> },
    { key: 'activity', header: 'Last activity', render: (w) => <DateCell ts={w.lastActivity} /> },
    {
      key: 'actions', header: 'Actions', hideHeader: true, align: 'right',
      render: (w) => (
        <div className="cell-actions">
          <button className="btn ghost small" onClick={() => setEditingFee(w)}>Rates</button>
          {w.status === 'active'
            ? <button className="btn ghost small" onClick={() => setSuspending(w)}>Suspend</button>
            : <button className="btn ghost small" disabled={isBusy} onClick={() => changeStatus(w, 'active')}>Reactivate</button>}
        </div>
      ),
    },
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
        actions={
          <>
            <Link className="btn ghost" to="/payments">Back to the console</Link>
            <button className="btn" onClick={() => setOnboardOpen(true)}>Add agency</button>
          </>
        }
      />

      <StatGrid>
        <StatCard isUnknown={!overview} label="Agencies" value={overview?.counts.workspaces_active ?? 0} sub={`${overview?.counts.workspaces ?? 0} in total`} />
        <StatCard isUnknown={!overview} label="Gross processed" value={<Money amount={overview?.money.gross ?? 0} direction="in" />} sub={`${overview?.money.sales ?? 0} sales`} />
        <StatCard isUnknown={!overview} label="Platform fees" value={<Money amount={overview?.money.platform_fees ?? 0} />} sub="Charged to agencies" />
        <StatCard isUnknown={!overview} label="HigherPays margin" value={<Money amount={overview?.money.higherpays_margin ?? 0} direction="in" emphasis />} sub="After PSP costs" />
      </StatGrid>

      {isLoading ? <LoadingCard label="Loading agencies…" />
        : isError ? <ErrorCard message="Couldn't load the agency list." />
          : <DataTable columns={columns} rows={workspaces} rowKey={(w) => w.id} emptyTitle="No agencies yet." emptyHint="Add the first one from the header." />}

      {onboardOpen && (
        <OnboardAgencyModal
          onClose={() => setOnboardOpen(false)}
          onSubmit={async (input) => {
            const created = await onboardAgency(input);
            setOnboardOpen(false);
            toast(`${input.name} created. Invite sent to ${input.adminEmail}.`);
            return created;
          }}
        />
      )}

      {editingFee && (
        <RatesModal
          workspace={editingFee}
          onClose={() => setEditingFee(null)}
          onSubmit={async (input) => {
            await setPlatformFee(editingFee.id, input);
            setEditingFee(null);
            toast(`Rates updated for ${editingFee.name}.`);
          }}
        />
      )}

      <Modal open={suspending !== null} onClose={() => setSuspending(null)} title={suspending ? `Suspend ${suspending.name}?` : ''}
        subtitle="Nobody in the agency can sign in until it is reactivated. Their data and ledger stay untouched.">
        {suspending && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setSuspending(null)}>Keep active</button>
            <button className="btn danger" disabled={isBusy} onClick={() => changeStatus(suspending, 'suspended')}>{isBusy ? 'Suspending…' : 'Suspend'}</button>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** Everything a new agency needs, in one form. The first admin gets an invite. */
function OnboardAgencyModal({ onClose, onSubmit }: {
  onClose: () => void;
  onSubmit: (input: OnboardAgencyInput) => Promise<{ workspaceId: string; webhookEndpointId: string }>;
}) {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(CURRENCIES[0]);
  const [merchantId, setMerchantId] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [pspRate, setPspRate] = useState('8');
  const [margin, setMargin] = useState('5');
  const [fixedFee, setFixedFee] = useState('0.50');
  const [chargebackFee, setChargebackFee] = useState('15');
  const [refundFee, setRefundFee] = useState('1');
  const [declineFee, setDeclineFee] = useState('0.25');
  const [accountSplit, setAccountSplit] = useState('70');
  const [agentPct, setAgentPct] = useState('0');
  const [isSaving, setIsSaving] = useState(false);

  const pct = { psp: parsePct(pspRate), margin: parsePct(margin), account: parsePct(accountSplit), agent: parsePct(agentPct) };
  const fees = { fixed: parseAmount(fixedFee), chargeback: parseAmount(chargebackFee), refund: parseAmount(refundFee), decline: parseAmount(declineFee) };
  const blended = Number.isNaN(pct.psp) || Number.isNaN(pct.margin) ? null : pct.psp + pct.margin;

  const submit = async () => {
    if (!name.trim()) { toast('Agency name is required.'); return; }
    if (!adminEmail.includes('@')) { toast('A valid admin email is required.'); return; }
    if (Object.values(pct).some(Number.isNaN)) { toast('Percentages must be 0–100.'); return; }
    if (pct.account + pct.agent > 100) { toast('Account share plus agent commission cannot exceed 100%.'); return; }
    if (Object.values(fees).some(Number.isNaN)) { toast('Fees must be amounts of 0 or more.'); return; }
    setIsSaving(true);
    try {
      await onSubmit({
        name: name.trim(), currency, merchantId: merchantId.trim() || undefined, adminEmail: adminEmail.trim(),
        pspRatePct: pct.psp, marginRatePct: pct.margin, pspFixedFee: fees.fixed,
        chargebackFee: fees.chargeback, refundFee: fees.refund, declineFee: fees.decline,
        accountSplitPct: pct.account, agentPct: pct.agent,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the agency.');
    } finally {
      setIsSaving(false);
    }
  };

  const pctField = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="pct-input">
        <input id={id} type="number" min={0} max={100} step={0.01} value={value} onChange={(e) => set(e.target.value)} />
        <span className="sub">%</span>
      </div>
    </div>
  );
  const amountField = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" min={0} step={0.01} value={value} onChange={(e) => set(e.target.value)} />
    </div>
  );

  return (
    <Modal open onClose={onClose} title="Add agency" subtitle="Creates the workspace with its rate card and sends its first admin an invite to set their password.">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="form-row">
          <div className="field">
            <label htmlFor="agency-name">Agency name</label>
            <input id="agency-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Select id="agency-currency" label="Currency" value={currency} onChange={setCurrency}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="agency-admin">First admin's email</label>
            <input id="agency-admin" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="agency-mid">MantaPay merchant ID</label>
            <input id="agency-mid" type="text" maxLength={64} placeholder="Optional" value={merchantId} onChange={(e) => setMerchantId(e.target.value)} />
          </div>
        </div>

        <div className="sechead">Rate card</div>
        <div className="form-row">
          {pctField('agency-psp', 'PSP rate', pspRate, setPspRate)}
          {pctField('agency-margin', 'HigherPays margin', margin, setMargin)}
          {amountField('agency-fixed', 'Fixed fee per transaction', fixedFee, setFixedFee)}
        </div>
        <p className="sub">Blended rate the agency sees: {blended === null ? '—' : `${blended}%`}.</p>

        <div className="sechead">Settlement fees</div>
        <div className="form-row">
          {amountField('agency-cb', 'Chargeback', chargebackFee, setChargebackFee)}
          {amountField('agency-refund', 'Refund', refundFee, setRefundFee)}
          {amountField('agency-decline', 'Decline', declineFee, setDeclineFee)}
        </div>

        <div className="sechead">Default split for new people</div>
        <div className="form-row">
          {pctField('agency-account-split', 'Account share', accountSplit, setAccountSplit)}
          {pctField('agency-agent-pct', 'Agent commission', agentPct, setAgentPct)}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={isSaving}>{isSaving ? 'Creating…' : 'Create agency'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** A new versioned rate row for one agency. */
function RatesModal({ workspace, onClose, onSubmit }: {
  workspace: PlatformWorkspace;
  onClose: () => void;
  onSubmit: (input: PlatformFeeRate) => Promise<void>;
}) {
  const [pspRate, setPspRate] = useState('');
  const [margin, setMargin] = useState('');
  const [fixedFee, setFixedFee] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const psp = parsePct(pspRate);
  const mrg = parsePct(margin);
  const fixed = parseAmount(fixedFee);
  const valid = !Number.isNaN(psp) && !Number.isNaN(mrg) && !Number.isNaN(fixed);

  const submit = async () => {
    if (!valid) { toast('Enter the PSP rate, margin and fixed fee.'); return; }
    setIsSaving(true);
    try { await onSubmit({ pspRatePct: psp, marginRatePct: mrg, pspFixedFee: fixed }); }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not save the rates.'); }
    finally { setIsSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={`Rates for ${workspace.name}`}
      subtitle={`Currently ${workspace.blendedRatePct}% blended. A new rate applies to sales from now on; the history is kept.`}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="form-row">
          <div className="field">
            <label htmlFor="rates-psp">PSP rate</label>
            <div className="pct-input">
              <input id="rates-psp" type="number" min={0} max={100} step={0.01} value={pspRate} onChange={(e) => setPspRate(e.target.value)} />
              <span className="sub">%</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="rates-margin">HigherPays margin</label>
            <div className="pct-input">
              <input id="rates-margin" type="number" min={0} max={100} step={0.01} value={margin} onChange={(e) => setMargin(e.target.value)} />
              <span className="sub">%</span>
            </div>
          </div>
        </div>
        <div className="field">
          <label htmlFor="rates-fixed">Fixed fee per transaction</label>
          <input id="rates-fixed" type="number" min={0} step={0.01} value={fixedFee} onChange={(e) => setFixedFee(e.target.value)} />
        </div>
        <p className="sub">New blended rate: {valid ? `${psp + mrg}%` : '—'}.</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={isSaving || !valid}>{isSaving ? 'Saving…' : 'Save rates'}</button>
        </div>
      </form>
    </Modal>
  );
}
