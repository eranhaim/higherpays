import { useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { formatMoney, sum } from '../../lib/format';
import { toast } from '../../lib/toast';
import Modal from '../../components/Modal';
import {
  PageHeader, StatCard, StatGrid, Money, Pill, DetailRow, EmptyState, LoadingCard, ErrorCard,
  DateRangePicker, type DateRange,
} from '../../components/ui';
import { usePayoutsData, type PayoutPeriod } from './usePayoutsData';

/** A payout the user has asked for but not yet confirmed. */
interface PendingPayout {
  payeeType: 'account' | 'agent';
  targetId?: string;
  /** Who is being paid, as it reads in the confirmation: "all accounts", "Mia". */
  label: string;
  amount: number;
  payeeCount: number;
}

export default function PayoutsPage() {
  const can = useCan();
  const { labels } = useCurrentSession();
  const [period, setPeriod] = useState<PayoutPeriod>('month');
  // A custom range overrides the preset. Setting one clears the other so the
  // header never claims a period the figures don't come from — and a payout
  // settles exactly the entries in the window on screen.
  const [custom, setCustom] = useState<DateRange>({ from: '', to: '' });
  const [pending, setPending] = useState<PendingPayout | null>(null);
  const { data, isLoading, isError, pay, isPaying } = usePayoutsData(period, custom);
  const canPay = can('revenue.manage');

  const usingCustom = Boolean(custom.from || custom.to);
  const periodLabel = usingCustom ? 'the selected range' : period === 'month' ? 'this month' : period === 'week' ? 'this week' : 'the last 12 months';

  const header = (
    <PageHeader
      title="Payouts"
      subtitle={`What you owe your ${labels.accounts.toLowerCase()} and ${labels.agents.toLowerCase()} for ${periodLabel}.`}
      actions={
        <>
          <div className="field">
            <label htmlFor="payout-period">Period</label>
            <select id="payout-period" value={usingCustom ? '' : period}
              onChange={(e) => { setCustom({ from: '', to: '' }); setPeriod(e.target.value as PayoutPeriod); }}>
              {usingCustom && <option value="">Custom range</option>}
              <option value="month">This month</option>
              <option value="week">This week</option>
              <option value="all">Last 12 months</option>
            </select>
          </div>
          <DateRangePicker value={custom} onChange={setCustom} />
        </>
      }
    />
  );

  if (isLoading) return <div>{header}<LoadingCard label="Loading payout breakdown…" /></div>;
  if (isError || !data) return <div>{header}<ErrorCard message="Couldn't load the payout breakdown." /></div>;

  const accountsOwed = sum(data.perAccount.map((c) => c.owed));
  const agentsOwed = sum(data.perAgent.map((c) => c.owed));
  const owedTotal = accountsOwed + agentsOwed;
  const { cash } = data;
  const cashScale = Math.max(owedTotal, cash.received, 1);
  const accountsWithBalance = data.perAccount.filter((c) => c.owed > 0).length;
  const agentsWithBalance = data.perAgent.filter((c) => c.owed > 0).length;

  const confirmPayout = async (p: PendingPayout) => {
    try {
      const result = await pay({ payeeType: p.payeeType, targetId: p.targetId });
      setPending(null);
      toast(result.ran === 0 ? `Nothing owed to ${p.label}.` : `Paid ${formatMoney(result.total)} to ${p.label}.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Payout failed.');
    }
  };

  const payButton = (payeeType: 'account' | 'agent', targetId: string, label: string, amount: number) =>
    canPay ? <button className="btn ghost small" onClick={() => setPending({ payeeType, targetId, label, amount, payeeCount: 1 })}>Pay</button> : null;

  return (
    <div>
      {header}

      <StatGrid>
        <StatCard label={`Owed to ${labels.accounts.toLowerCase()}`} value={<Money amount={accountsOwed} direction="out" emphasis />} sub="Their share this period" />
        <StatCard label={`Owed to ${labels.agents.toLowerCase()}`} value={<Money amount={agentsOwed} direction="out" emphasis />} sub="Commissions this period" />
        <StatCard label="Owed in total" value={<Money amount={owedTotal} direction="out" />} sub="Not yet paid out" />
        <StatCard label="Held in reserve" value={<Money amount={data.reserve.held} />}
          sub={data.reserve.pct ? `${data.reserve.pct}% · released after ${data.reserve.releaseDays} days` : 'No reserve configured'} />
      </StatGrid>

      {(owedTotal > 0 || cash.heldInReserve > 0) && (
        <div className="card section">
          <div className="sechead">Cash position</div>
          <p className="sub">What reached you this period after fees, less the reserve MantaPay holds back, is what you can pay out today.</p>
          <div className="metric-row">
            <span className="ml wide">Received after fees</span>
            <span className="mt"><span className="tone-pos" style={{ width: `${(cash.received / cashScale) * 100}%` }} /></span>
            <span className="mv">{formatMoney(cash.received)}</span>
          </div>
          <div className="metric-row">
            <span className="ml wide">Held in reserve</span>
            <span className="mt"><span className="tone-accent" style={{ width: `${(cash.heldInReserve / cashScale) * 100}%` }} /></span>
            <span className="mv">{formatMoney(cash.heldInReserve)}</span>
          </div>
          <div className="metric-row">
            <span className="ml wide">Owed to {labels.accounts.toLowerCase()} and {labels.agents.toLowerCase()}</span>
            <span className="mt"><span style={{ width: `${(owedTotal / cashScale) * 100}%` }} /></span>
            <span className="mv">{formatMoney(owedTotal)}</span>
          </div>
          {cash.shortfallIfPaidNow > 0 ? (
            <div className="warnbar">Paying everyone now leaves you {formatMoney(cash.shortfallIfPaidNow)} short. That is cash you front until the reserve is released.</div>
          ) : <p className="sub">You can pay everyone in full from this period's receipts.</p>}
          {cash.heldInReserve > 0 && data.reserve.source === 'estimated' && (
            <p className="sub">Reserve estimated from your {data.reserve.pct}% rate. Import a settlement report for the exact figure.</p>
          )}
        </div>
      )}

      <div className="card section">
        <div className="sechead row">
          <span>{labels.account} payouts</span>
          {canPay && accountsOwed > 0 && (
            <button className="btn ghost small" onClick={() => setPending({ payeeType: 'account', label: `all ${labels.accounts.toLowerCase()}`, amount: accountsOwed, payeeCount: accountsWithBalance })}>
              Pay all {labels.accounts.toLowerCase()}
            </button>
          )}
        </div>
        <div className="tablewrap flush">
          <table>
            <thead>
              <tr>
                <th scope="col">{labels.account}</th>
                <th scope="col">Revenue</th>
                <th scope="col">Owed</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.perAccount.length === 0 ? (
                <tr><td colSpan={4}><EmptyState title={`No ${labels.accounts.toLowerCase()} yet.`} /></td></tr>
              ) : data.perAccount.map((c) => (
                <tr key={c.id}>
                  <td className="cname">{c.name}</td>
                  <td><Money amount={c.revenue} direction="in" /></td>
                  <td><Money amount={c.owed} direction="out" emphasis /></td>
                  <td>{c.owed > 0 ? <><Pill tone="ok">Accruing</Pill> {payButton('account', c.id, c.name, c.owed)}</> : <Pill>Settled</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card section">
        <div className="sechead row">
          <span>{labels.agent} payouts</span>
          {canPay && agentsOwed > 0 && (
            <button className="btn ghost small" onClick={() => setPending({ payeeType: 'agent', label: `all ${labels.agents.toLowerCase()}`, amount: agentsOwed, payeeCount: agentsWithBalance })}>
              Pay all {labels.agents.toLowerCase()}
            </button>
          )}
        </div>
        <div className="tablewrap flush">
          <table>
            <thead>
              <tr>
                <th scope="col">{labels.agent}</th>
                <th scope="col">Sales</th>
                <th scope="col">Commission owed</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.perAgent.length === 0 ? (
                <tr><td colSpan={4}><EmptyState title={`No ${labels.agents.toLowerCase()} yet.`} /></td></tr>
              ) : data.perAgent.map((c) => (
                <tr key={c.id}>
                  <td className="cname">{c.name}</td>
                  <td>{c.sales}</td>
                  <td><Money amount={c.owed} direction="out" emphasis /></td>
                  <td>{c.owed > 0 ? <><Pill tone="ok">Accruing</Pill> {payButton('agent', c.id, c.name, c.owed)}</> : <Pill>Settled</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub">Balances accrue from paid sales in the selected period. Paying marks them as settled in the ledger.</p>
      </div>

      <Modal open={pending !== null} onClose={() => setPending(null)} title={pending ? `Pay ${pending.label}?` : ''}
        subtitle="This settles the balance in the ledger and cannot be undone here.">
        {pending && (
          <>
            <div className="callout">
              <DetailRow label={pending.payeeCount === 1 ? 'Payee' : 'Payees'}>{pending.payeeCount === 1 ? pending.label : `${pending.payeeCount} with a balance`}</DetailRow>
              <DetailRow label="Total to pay"><Money amount={pending.amount} direction="out" emphasis /></DetailRow>
            </div>
            {cash.shortfallIfPaidNow > 0 && (
              <div className="warnbar">You are {formatMoney(cash.shortfallIfPaidNow)} short across all balances this period. Paying now fronts that cash yourself.</div>
            )}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setPending(null)}>Cancel</button>
              <button className="btn" disabled={isPaying} onClick={() => confirmPayout(pending)}>{isPaying ? 'Paying…' : `Pay ${formatMoney(pending.amount)}`}</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
