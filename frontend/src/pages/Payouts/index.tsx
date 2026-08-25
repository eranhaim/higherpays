import { useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { formatMoney, sum } from '../../lib/format';
import { toast } from '../../lib/toast';
import Modal from '../../components/Modal';
import {
  PageHeader, StatCard, StatGrid, Money, Pill, DetailRow, EmptyState, LoadingCard, ErrorCard,
} from '../../components/ui';
import { REVENUE_MODEL_LABELS } from '../../api/endpoints';
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
  const [period, setPeriod] = useState<PayoutPeriod>('month');
  const [pending, setPending] = useState<PendingPayout | null>(null);
  const { data, isLoading, isError, pay, isPaying } = usePayoutsData(period);
  const canPay = can('commissions.manage');

  const header = (
    <PageHeader
      eyebrow="Money out"
      title="Payouts"
      subtitle="What you owe your accounts and team for the period."
      actions={
        <div className="field">
          <label htmlFor="payout-period">Period</label>
          <select id="payout-period" value={period} onChange={(e) => setPeriod(e.target.value as PayoutPeriod)}>
            <option value="month">This month</option>
            <option value="week">This week</option>
            <option value="all">Last 12 months</option>
          </select>
        </div>
      }
    />
  );

  if (!can('commissions.view')) {
    return (
      <div>
        {header}
        <div className="card">
          <EmptyState title="You don't have access to payouts." hint="Ask an owner or admin if you need it." />
        </div>
      </div>
    );
  }
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
      toast(result.ran === 0
        ? `Nothing owed to ${p.label}.`
        : `Paid ${formatMoney(result.total)} to ${p.label}.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Payout failed.');
    }
  };

  return (
    <div>
      {header}

      <StatGrid>
        <StatCard label="Owed to accounts" value={<Money amount={accountsOwed} direction="out" emphasis />} sub="Rev-share this period" />
        <StatCard label="Owed to team" value={<Money amount={agentsOwed} direction="out" emphasis />} sub="Commissions this period" />
        <StatCard label="Owed in total" value={<Money amount={owedTotal} direction="out" />} sub="Not yet paid out" />
        <StatCard
          label="Held in reserve"
          value={<Money amount={data.reserve.held} />}
          sub={data.reserve.pct ? `${data.reserve.pct}% · released after ${data.reserve.releaseDays} days` : 'No reserve configured'}
        />
      </StatGrid>

      {(owedTotal > 0 || cash.heldInReserve > 0) && (
        <div className="card section">
          <div className="sechead">Cash position</div>
          <p className="sub">
            What reached you this period after fees, less the reserve MantaPay holds back, is what you can pay out today.
          </p>
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
            <span className="ml wide">Owed to accounts and team</span>
            <span className="mt"><span style={{ width: `${(owedTotal / cashScale) * 100}%` }} /></span>
            <span className="mv">{formatMoney(owedTotal)}</span>
          </div>
          {cash.shortfallIfPaidNow > 0 ? (
            <div className="warnbar">
              Paying everyone now leaves you {formatMoney(cash.shortfallIfPaidNow)} short. That is cash you front until the reserve is released.
            </div>
          ) : (
            <p className="sub">You can pay everyone in full from this period's receipts.</p>
          )}
          {cash.heldInReserve > 0 && data.reserve.source === 'estimated' && (
            <p className="sub">Reserve estimated from your {data.reserve.pct}% rate. Import a settlement report for the exact figure.</p>
          )}
        </div>
      )}

      <div className="card section">
        <div className="sechead row">
          <span>Account payouts</span>
          {canPay && accountsOwed > 0 && (
            <button
              className="btn ghost small"
              onClick={() => setPending({
                payeeType: 'account',
                label: 'all accounts',
                amount: accountsOwed,
                payeeCount: accountsWithBalance,
              })}
            >
              Pay all accounts
            </button>
          )}
        </div>
        <div className="tablewrap flush">
          <table>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Model</th>
                <th scope="col">Revenue</th>
                <th scope="col">Owed</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.perAccount.length === 0 ? (
                <tr><td colSpan={5}><EmptyState title="No accounts yet." /></td></tr>
              ) : data.perAccount.map((c) => (
                <tr key={c.id}>
                  <td className="cname">{c.name}</td>
                  <td><Pill>{REVENUE_MODEL_LABELS[c.model]}</Pill></td>
                  <td><Money amount={c.revenue} direction="in" /></td>
                  <td>
                    {c.model === 'salary'
                      ? <><Money amount={c.salary} direction="out" emphasis /> <span className="sub inline">/ month</span></>
                      : <Money amount={c.owed} direction="out" emphasis />}
                  </td>
                  <td>
                    {c.model === 'salary' ? (
                      <Pill>Salary</Pill>
                    ) : c.owed > 0 ? (
                      <>
                        <Pill tone="ok">Accruing</Pill>
                        {canPay && (
                          <button
                            className="btn ghost small"
                            onClick={() => setPending({
                              payeeType: 'account', targetId: c.id,
                              label: c.name, amount: c.owed, payeeCount: 1,
                            })}
                          >
                            Pay
                          </button>
                        )}
                      </>
                    ) : <Pill>Settled</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card section">
        <div className="sechead row">
          <span>Agent payouts</span>
          {canPay && agentsOwed > 0 && (
            <button
              className="btn ghost small"
              onClick={() => setPending({
                payeeType: 'agent',
                label: 'all agents',
                amount: agentsOwed,
                payeeCount: agentsWithBalance,
              })}
            >
              Pay all agents
            </button>
          )}
        </div>
        <div className="tablewrap flush">
          <table>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Sales</th>
                <th scope="col">Commission owed</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.perAgent.length === 0 ? (
                <tr><td colSpan={4}><EmptyState title="No agents yet." /></td></tr>
              ) : data.perAgent.map((c) => (
                <tr key={c.id}>
                  <td className="cname">{c.name}</td>
                  <td>{c.sales}</td>
                  <td><Money amount={c.owed} direction="out" emphasis /></td>
                  <td>
                    {c.owed > 0 ? (
                      <>
                        <Pill tone="ok">Accruing</Pill>
                        {canPay && (
                          <button
                            className="btn ghost small"
                            onClick={() => setPending({
                              payeeType: 'agent', targetId: c.id,
                              label: c.name, amount: c.owed, payeeCount: 1,
                            })}
                          >
                            Pay
                          </button>
                        )}
                      </>
                    ) : <Pill>Settled</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub">Balances accrue from paid sales in the selected period. Paying marks them as settled in the ledger.</p>
      </div>

      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending ? `Pay ${pending.label}?` : ''}
        subtitle="This settles the balance in the ledger and cannot be undone here."
      >
        {pending && (
          <>
            <div className="callout">
              <DetailRow label={pending.payeeCount === 1 ? 'Payee' : 'Payees'}>
                {pending.payeeCount === 1 ? pending.label : `${pending.payeeCount} with a balance`}
              </DetailRow>
              <DetailRow label="Total to pay">
                <Money amount={pending.amount} direction="out" emphasis />
              </DetailRow>
            </div>
            {cash.shortfallIfPaidNow > 0 && (
              <div className="warnbar">
                You are {formatMoney(cash.shortfallIfPaidNow)} short across all balances this period. Paying now fronts that cash yourself.
              </div>
            )}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setPending(null)}>Cancel</button>
              <button className="btn" disabled={isPaying} onClick={() => confirmPayout(pending)}>
                {isPaying ? 'Paying…' : `Pay ${formatMoney(pending.amount)}`}
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
