import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  PageHeader, Pill, DataTable, Money, DateCell, EmptyState, LoadingCard, ErrorCard, StatCard, StatGrid,
  Select, type Column,
} from '../../components/ui';
import { platformApi, type PlatformWorkspace, type OnboardAgencyInput, type PlatformUser } from '../../api/endpoints';
import Modal from '../../components/Modal';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useSessionStore } from '../../store/session';
import { toast } from '../../lib/toast';
import { usePlatformData } from './usePlatformData';

const CURRENCIES = ['EUR', 'USD', 'GBP'];

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
    isPlatformAdmin, requiresTwoFactor, overview, workspaces, supportedCurrencies, isLoading, isError,
    onboardAgency, setStatus,
  } = usePlatformData();
  const [onboardOpen, setOnboardOpen] = useState(false);
  const [suspending, setSuspending] = useState<PlatformWorkspace | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const setActiveWorkspaceId = useSessionStore((s) => s.setActiveWorkspaceId);
  const { workspaces: memberships } = useCurrentSession();
  const users = useQuery({ queryKey: ['platform-users'], queryFn: () => platformApi.listUsers(), enabled: isPlatformAdmin && !requiresTwoFactor });
  const platformAdmin = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => platformApi.setPlatformAdmin(id, enabled),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['platform-users'] }); },
  });

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

  // `/settings` is workspace-scoped, so the row's agency has to become the
  // active one first. This table also lists suspended and archived agencies,
  // which `/auth/me` leaves out: selecting one would send its id as
  // X-Workspace-Id while the console labelled itself from another agency.
  const openWorkspaceSettings = (w: PlatformWorkspace) => {
    if (!memberships.some((m) => m.id === w.id)) {
      toast(`${w.name} has to be active before its settings can be opened.`);
      return;
    }
    setActiveWorkspaceId(w.id);
    // Every cached query is scoped to the agency that was active until now.
    queryClient.clear();
    navigate('/settings?tab=workspace');
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
          <button className="btn small" onClick={() => openWorkspaceSettings(w)}>Edit settings</button>
          {w.status === 'active'
            ? <button className="btn danger small" onClick={() => setSuspending(w)}>Suspend</button>
            : <button className="btn small" disabled={isBusy} onClick={() => changeStatus(w, 'active')}>Reactivate</button>}
        </div>
      ),
    },
  ];
  const userColumns: Column<PlatformUser>[] = [
    { key: 'person', header: 'User', render: (u) => <div><span className="cname">{u.fullName}</span><span className="cemail">{u.email}</span></div> },
    { key: 'access', header: 'Access', render: (u) => <>{u.isPlatformAdmin && <Pill tone="info">Platform admin</Pill>} {!u.isPlatformAdmin && <Pill>Agency user</Pill>}</> },
    { key: 'workspaces', header: 'Agencies', render: (u) => <span className="sub">{u.memberships.map((m) => `${m.workspaceName} · ${m.role}`).join(' · ') || 'No agency access'}</span> },
    { key: 'login', header: 'Last sign-in', render: (u) => u.lastLoginAt ? <DateCell ts={u.lastLoginAt} /> : <span className="sub">Never</span> },
    {
      key: 'actions', header: 'Actions', hideHeader: true, align: 'right',
      render: (u) => <button className="btn ghost small" disabled={platformAdmin.isPending}
        onClick={() => platformAdmin.mutate({ id: u.id, enabled: !u.isPlatformAdmin })}>
        {u.isPlatformAdmin ? 'Remove platform admin' : 'Make platform admin'}
      </button>,
    },
  ];

  if (!isPlatformAdmin) {
    return (
      <div className="page">
        <div className="card">
          <EmptyState title="This console is for HigherPays operators." hint="Your account is not a platform admin." />
        </div>
      </div>
    );
  }
  if (requiresTwoFactor) {
    return (
      <div className="page">
        <div className="card">
          <EmptyState
            title="Two-factor authentication is required."
            hint="Protect your platform-admin account before using operator controls."
            action={<Link className="btn" to="/settings?tab=account">Enable 2FA</Link>}
          />
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

      <div className="section">
        <div className="sechead">All users</div>
        <p className="sub">Platform-wide access. For agency-specific roles and invitations, open that agency’s People & access page.</p>
        <DataTable columns={userColumns} rows={users.data ?? []} rowKey={(u) => u.id}
          isLoading={users.isLoading} emptyTitle="No users yet." />
      </div>

      {onboardOpen && (
        <OnboardAgencyModal
          currencies={supportedCurrencies}
          onClose={() => setOnboardOpen(false)}
          onSubmit={async (input) => {
            const created = await onboardAgency(input);
            setOnboardOpen(false);
            toast(`${input.name} created. Invite sent to ${input.adminEmail}.`);
            return created;
          }}
        />
      )}

      <Modal open={suspending !== null} onClose={() => setSuspending(null)} title={suspending ? `Suspend ${suspending.name}?` : ''}
        subtitle="Nobody in the agency can sign in until it is reactivated. Their data and their money records stay untouched.">
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
function OnboardAgencyModal({ currencies, onClose, onSubmit }: {
  currencies: string[];
  onClose: () => void;
  onSubmit: (input: OnboardAgencyInput) => Promise<{ workspaceId: string; webhookEndpointId: string }>;
}) {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(currencies[0] ?? CURRENCIES[0]);
  const [merchantId, setMerchantId] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [pspRate, setPspRate] = useState('8');
  const [margin, setMargin] = useState('5');
  const [fixedFee, setFixedFee] = useState('0.50');
  const [settlementPct, setSettlementPct] = useState('0');
  const [checkoutFee, setCheckoutFee] = useState('2.00');
  const [isSaving, setIsSaving] = useState(false);

  const pct = { psp: parsePct(pspRate), margin: parsePct(margin), settlement: parsePct(settlementPct) };
  const fees = {
    fixed: parseAmount(fixedFee), checkout: parseAmount(checkoutFee),
  };
  const blended = Object.values(pct).some(Number.isNaN) ? null : pct.psp + pct.settlement + pct.margin;

  const submit = async () => {
    if (!name.trim()) { toast('Agency name is required.'); return; }
    if (!adminEmail.includes('@')) { toast('A valid admin email is required.'); return; }
    if (Object.values(pct).some(Number.isNaN)) { toast('Percentages must be 0–100.'); return; }
    if (Object.values(fees).some(Number.isNaN)) { toast('Fees must be amounts of 0 or more.'); return; }
    setIsSaving(true);
    try {
      await onSubmit({
        name: name.trim(), currency, merchantId: merchantId.trim() || undefined, adminEmail: adminEmail.trim(),
        pspRatePct: pct.psp, settlementPct: pct.settlement, marginRatePct: pct.margin,
        pspFixedFee: fees.fixed, checkoutFee: fees.checkout,
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
            {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
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
          {pctField('agency-psp', 'MDR rate', pspRate, setPspRate)}
          {pctField('agency-settlement', 'Settlement fee', settlementPct, setSettlementPct)}
          {pctField('agency-margin', 'HigherPays margin', margin, setMargin)}
          {amountField('agency-fixed', 'Transaction fee', fixedFee, setFixedFee)}
          {amountField('agency-checkout', 'Checkout fee (paid by the customer)', checkoutFee, setCheckoutFee)}
        </div>
        <p className="sub">Blended rate the agency sees: {blended === null ? '—' : `${blended}%`}.</p>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={isSaving}>{isSaving ? 'Creating…' : 'Create agency'}</button>
        </div>
      </form>
    </Modal>
  );
}
