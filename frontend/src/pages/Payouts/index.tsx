import { useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { formatMoney, sum } from '../../lib/format';
import { toast } from '../../lib/toast';
import {
  PageHeader, StatCard, StatGrid, Money, Pill, EmptyState, LoadingCard, ErrorCard,
} from '../../components/ui';
import { REVENUE_MODEL_LABELS } from '../../api/endpoints';
import { usePayoutsData, type PayoutPeriod } from './usePayoutsData';

export default function PayoutsPage() {
  const can = useCan();
  const [period, setPeriod] = useState<PayoutPeriod>('month');
  const { data, isLoading, isError, pay, isPaying } = usePayoutsData(period);
  const canPay = can('commissions.manage');

  const header = (
    <PageHeader
      eyebrow="Money out"
      title="Payouts"
      subtitle="What you owe your creators and team for the period."
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

  const creatorsOwed = sum(data.perCreator.map((c) => c.owed));
  const chattersOwed = sum(data.perChatter.map((c) => c.owed));
  const owedTotal = creatorsOwed + chattersOwed;
  const reserveScale = Math.max(owedTotal, data.reserve.held, 1);

  const runPayout = async (input: { payeeType: 'creator' | 'chatter'; targetId?: string }, label: string) => {
    try {
      const result = await pay(input);
      toast(result.ran === 0
        ? `Nothing owed to ${label}.`
        : `Paid ${formatMoney(result.total)} to ${label}.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Payout failed.');
    }
  };

  return (
    <div>
      {header}

      <StatGrid>
        <StatCard label="Owed to creators" value={<Money amount={creatorsOwed} direction="out" emphasis />} sub="Rev-share this period" />
        <StatCard label="Owed to team" value={<Money amount={chattersOwed} direction="out" emphasis />} sub="Commissions this period" />
        <StatCard label="Owed in total" value={<Money amount={owedTotal} direction="out" />} sub="Not yet paid out" />
        <StatCard
          label="Held in reserve"
          value={<Money amount={data.reserve.held} />}
          sub={data.reserve.pct ? `${data.reserve.pct}% · released after ${data.reserve.releaseDays} days` : 'No reserve configured'}
        />
      </StatGrid>

      {data.reserve.held > 0 && (
        <div className="card section">
          <div className="sechead">Cash position</div>
          <p className="sub">
            The reserve is your money, held by MantaPay and released later. If you pay everyone in full today, you front that amount yourself.
          </p>
          <div className="metric-row">
            <span className="ml wide">Owed to creators and team</span>
            <span className="mt"><span style={{ width: `${(owedTotal / reserveScale) * 100}%` }} /></span>
            <span className="mv">{formatMoney(owedTotal)}</span>
          </div>
          <div className="metric-row">
            <span className="ml wide">Held in reserve</span>
            <span className="mt"><span className="tone-accent" style={{ width: `${(data.reserve.held / reserveScale) * 100}%` }} /></span>
            <span className="mv">{formatMoney(data.reserve.held)}</span>
          </div>
          {data.reserve.source === 'estimated' && (
            <div className="warnbar">
              Estimated from your {data.reserve.pct}% reserve rate. Import a settlement report for the exact figure.
            </div>
          )}
        </div>
      )}

      <div className="card section">
        <div className="sechead row">
          <span>Creator payouts</span>
          {canPay && creatorsOwed > 0 && (
            <button className="btn ghost small" disabled={isPaying} onClick={() => runPayout({ payeeType: 'creator' }, 'all creators')}>
              Pay all creators
            </button>
          )}
        </div>
        <div className="tablewrap flush">
          <table>
            <thead>
              <tr><th>Creator</th><th>Model</th><th>Revenue</th><th>Owed</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.perCreator.length === 0 ? (
                <tr><td colSpan={5}><EmptyState title="No creators yet." /></td></tr>
              ) : data.perCreator.map((c) => (
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
                          <button className="btn ghost small" disabled={isPaying} onClick={() => runPayout({ payeeType: 'creator', targetId: c.id }, c.name)}>
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
          <span>Chatter payouts</span>
          {canPay && chattersOwed > 0 && (
            <button className="btn ghost small" disabled={isPaying} onClick={() => runPayout({ payeeType: 'chatter' }, 'all chatters')}>
              Pay all chatters
            </button>
          )}
        </div>
        <div className="tablewrap flush">
          <table>
            <thead>
              <tr><th>Chatter</th><th>Sales</th><th>Commission owed</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.perChatter.length === 0 ? (
                <tr><td colSpan={4}><EmptyState title="No chatters yet." /></td></tr>
              ) : data.perChatter.map((c) => (
                <tr key={c.id}>
                  <td className="cname">{c.name}</td>
                  <td>{c.sales}</td>
                  <td><Money amount={c.owed} direction="out" emphasis /></td>
                  <td>
                    {c.owed > 0 ? (
                      <>
                        <Pill tone="ok">Accruing</Pill>
                        {canPay && (
                          <button className="btn ghost small" disabled={isPaying} onClick={() => runPayout({ payeeType: 'chatter', targetId: c.id }, c.name)}>
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
    </div>
  );
}
