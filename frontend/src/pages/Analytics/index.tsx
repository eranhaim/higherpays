/**
 * Analytics page. Thin view over `useAnalyticsData` plus the shared UI kit.
 */

import { useState } from 'react';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useCan } from '../../hooks/usePermission';
import { REVENUE_MODEL_LABELS, type AnalyticsReport } from '../../api/endpoints';
import { toIsoDate, DAY_MS, MONTHS_SHORT } from '../../lib/format';
import { toast } from '../../lib/toast';
import {
  PageHeader, StatCard, StatGrid, Money, Pill, DataTable, DetailRow, LoadingCard, ErrorCard,
  type Column,
} from '../../components/ui';
import { BarChart, Heatmap, MetricRow, type BarPoint } from './charts';
import {
  useAnalyticsData, defaultFilters, toLocalDateInput,
  type AnalyticsFilters, type DateWindow,
} from './useAnalyticsData';

const pct = (v: number) => `${v.toFixed(1)}%`;

function share(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

interface Delta {
  text: string;
  trend?: 'up' | 'down';
}

function deltaText(current: number, previous: number | undefined): Delta | null {
  if (previous === undefined) return null;
  if (previous === 0) return { text: 'no previous data' };
  const change = ((current - previous) / previous) * 100;
  const arrow = change >= 0 ? '▲' : '▼';
  return {
    text: `${arrow} ${Math.abs(Math.round(change))}% vs previous`,
    trend: change > 0 ? 'up' : change < 0 ? 'down' : undefined,
  };
}

/** One bar per calendar day in the window; days without sales stay at zero. */
function dailyBars(
  timeseries: AnalyticsReport['timeseries'],
  dateWindow: DateWindow,
  metric: 'gross' | 'net',
): BarPoint[] {
  const byDay = new Map(timeseries.map((t) => [t.d, t[metric]]));
  const start = new Date(dateWindow.fromMs);
  const bars: BarPoint[] = [];
  // Step by calendar day rather than by 24h so a DST change cannot skip or repeat a day.
  for (let i = 0; ; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (d.getTime() > dateWindow.toMs) break;
    const iso = toLocalDateInput(d.getTime());
    bars.push({
      id: iso,
      label: `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`,
      value: byDay.get(iso) ?? 0,
    });
  }
  return bars;
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadCSV(text: string, name: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildCSV(report: AnalyticsReport, workspaceName: string, filters: AnalyticsFilters): string {
  const rows: string[] = [];
  const push = (...cells: unknown[]) => rows.push(cells.map(csvCell).join(','));
  const h = report.headline;
  const c = report.chargebacks;

  push('HigherPays analytics export');
  push('Workspace', workspaceName);
  push('Range', filters.from, 'to', filters.to);
  push('Generated', new Date().toISOString());
  push('');
  push('SUMMARY');
  push('Metric', 'Value');
  // The export mirrors the page: a scoped caller's report has no agency-side
  // figures and no per-party tables, so writing those headings would produce
  // blank rows under empty sections rather than an honest smaller file.
  const seesAgencyFigures = report.scope === 'agency';

  push('Gross', h.gross);
  push('Net', h.net);
  push('Avg order', h.aov);
  push('Paid sales', h.paidCount);
  push('Unique buyers', h.uniqueBuyers);
  if (seesAgencyFigures) {
    push('Take rate %', h.takeRatePct);
    push('Platform fee', h.platformFee);
    push('Account payout', h.accountPayout);
    push('Agent payout', h.agentPayout);
    push('Agency keep', h.agencyKeep);
  }
  push('Chargeback rate %', c.ratePct);
  push('');
  push('REVENUE OVER TIME');
  push('Date', 'Gross', 'Net');
  report.timeseries.forEach((t) => push(t.d, t.gross, t.net));

  if (seesAgencyFigures) {
    push('');
    push('AGENT LEADERBOARD');
    push('Agent', 'Revenue', 'Sales', 'Conversion %', 'Avg order');
    report.agents.forEach((r) => push(r.name, r.revenue, r.sales, r.conversionPct ?? '', r.aov));
    push('');
    push('ACCOUNT PERFORMANCE');
    push('Account', 'Model', 'Revenue', 'Account payout', 'Agency profit');
    report.accounts.forEach((r) => push(r.name, r.model, r.revenue, r.accountPayout, r.agencyProfit));
  }
  return rows.join('\n');
}

type AgentRow = AnalyticsReport['agents'][number] & { rank: number };
type AccountRow = AnalyticsReport['accounts'][number];

const agentColumns: Column<AgentRow>[] = [
  { key: 'rank', header: '#', width: 48, render: (r) => <span className="mono">{r.rank}</span> },
  { key: 'name', header: 'Agent', render: (r) => <span className="cname">{r.name}</span> },
  { key: 'revenue', header: 'Revenue', align: 'right', render: (r) => <Money amount={r.revenue} direction="in" /> },
  { key: 'sales', header: 'Sales', align: 'right', render: (r) => <span className="mono">{r.sales}</span> },
  { key: 'conversion', header: 'Conversion', align: 'right', render: (r) => <span className="mono">{r.conversionPct === null ? '—' : pct(r.conversionPct)}</span> },
  { key: 'aov', header: 'Avg order', align: 'right', render: (r) => <Money amount={r.aov} /> },
];

const accountColumns: Column<AccountRow>[] = [
  { key: 'name', header: 'Account', render: (r) => <span className="cname">{r.name}</span> },
  { key: 'model', header: 'Model', render: (r) => <Pill>{REVENUE_MODEL_LABELS[r.model]}</Pill> },
  { key: 'revenue', header: 'Revenue', align: 'right', render: (r) => <Money amount={r.revenue} direction="in" /> },
  { key: 'payout', header: 'Account payout', align: 'right', render: (r) => <Money amount={r.accountPayout} direction="out" /> },
  { key: 'profit', header: 'Agency profit', align: 'right', render: (r) => <Money amount={r.agencyProfit} direction="in" /> },
  {
    key: 'note', header: 'Note',
    render: (r) => r.model === 'salary'
      ? <span className="fee">salary <Money amount={r.salary} />/mo</span>
      : null,
  },
];

export default function AnalyticsPage() {
  const { activeWorkspace, currency } = useCurrentSession();
  const can = useCan();
  // Whoever sees the whole workspace may also pivot to one account or agent and
  // read the agency-side figures. A scoped caller gets neither, and the server
  // omits those fields regardless — this only keeps the UI honest about it.
  const canScope = can('data.view_all');

  const [filters, setFilters] = useState<AnalyticsFilters>(defaultFilters);
  const [metric, setMetric] = useState<'gross' | 'net'>('gross');

  const { dateWindow, report, previous, isLoading, isError, accounts, agents } =
    useAnalyticsData(filters, canScope);

  const setLastDays = (days: number) => {
    const now = Date.now();
    setFilters((f) => ({ ...f, from: toLocalDateInput(now - days * DAY_MS), to: toLocalDateInput(now) }));
  };

  const exportCSV = () => {
    if (!report) { toast('Nothing to export yet.'); return; }
    downloadCSV(
      buildCSV(report, activeWorkspace?.name ?? '', filters),
      `higherpays-analytics-${toIsoDate(Date.now())}.csv`,
    );
    toast('Analytics exported to CSV.');
  };

  const actions = (
    <>
      <div className="field">
        <label htmlFor="analytics-from">From</label>
        <input id="analytics-from" type="date" value={filters.from} max={filters.to}
          onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
      </div>
      <div className="field">
        <label htmlFor="analytics-to">To</label>
        <input id="analytics-to" type="date" value={filters.to} min={filters.from}
          onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
      </div>
      <button className="btn ghost" onClick={() => setLastDays(14)}>14d</button>
      <button className="btn ghost" onClick={() => setLastDays(30)}>30d</button>
      <button className="btn ghost" onClick={() => setLastDays(90)}>90d</button>
      {canScope && (
        <>
          <select
            aria-label="Filter by account"
            value={filters.accountId}
            onChange={(e) => setFilters((f) => ({ ...f, accountId: e.target.value, agentId: '' }))}
          >
            <option value="">All accounts</option>
            {accounts.map((c) => <option key={c.id} value={c.id}>{c.stageName}</option>)}
          </select>
          <select
            aria-label="Filter by agent"
            value={filters.agentId}
            onChange={(e) => setFilters((f) => ({ ...f, agentId: e.target.value, accountId: '' }))}
          >
            <option value="">All agents</option>
            {agents.map((c) => <option key={c.membershipId} value={c.membershipId}>{c.name}</option>)}
          </select>
        </>
      )}
      {can('payments.export') && (
        <button className="btn ghost" onClick={exportCSV} disabled={!report}>Export CSV</button>
      )}
    </>
  );

  const header = (
    <PageHeader
      title="Analytics"
      subtitle={canScope ? activeWorkspace?.name ?? '' : 'Your performance'}
      actions={actions}
    />
  );

  if (!dateWindow) return <div>{header}<ErrorCard message="Choose a valid date range." /></div>;
  if (isLoading) return <div>{header}<LoadingCard /></div>;
  if (isError || !report) return <div>{header}<ErrorCard message="Could not load analytics." /></div>;

  const h = report.headline;
  const f = report.funnel;
  const cu = report.customers;
  const cb = report.chargebacks;
  const p = previous?.headline;

  const grossDelta = deltaText(h.gross, p?.gross);
  const netDelta = deltaText(h.net, p?.net);
  const takeDelta = deltaText(h.takeRatePct ?? 0, p?.takeRatePct);
  const aovDelta = deltaText(h.aov, p?.aov);
  const paidDelta = deltaText(h.paidCount, p?.paidCount);
  const buyersDelta = deltaText(h.uniqueBuyers, p?.uniqueBuyers);

  // The server omits these entirely for a scoped caller, so `canScope` and the
  // presence of the data agree; the sections below simply don't render.
  const parts = h.agencyKeep === undefined ? [] : [
    { label: 'Platform fee', amount: h.platformFee ?? 0, direction: 'out' as const, tone: 'tone-muted' as const },
    { label: 'Account payout', amount: h.accountPayout ?? 0, direction: 'out' as const, tone: 'tone-pos' as const },
    { label: 'Agent payout', amount: h.agentPayout ?? 0, direction: 'out' as const, tone: 'tone-info' as const },
    { label: 'Agency keep', amount: h.agencyKeep, direction: 'in' as const, tone: 'tone-accent' as const },
  ];
  const distributed = parts.reduce((sum, part) => sum + part.amount, 0);

  const segmentMax = Math.max(...cu.segments.map((s) => s.revenue), 1);
  const newVsReturningTotal = cu.newVsReturning.newRev + cu.newVsReturning.retRev;
  const byBearer = cb.byBearer;
  const lossTotal = byBearer ? byBearer.account + byBearer.agency : 0;

  return (
    <div>
      {header}

      <StatGrid>
        <StatCard label="Gross" value={<Money amount={h.gross} direction="in" />} sub={grossDelta?.text} trend={grossDelta?.trend} />
        <StatCard label="Net after fees" value={<Money amount={h.net} direction="in" emphasis />} sub={netDelta?.text} trend={netDelta?.trend} />
        {h.takeRatePct !== undefined && (
          <StatCard label="Take rate" value={pct(h.takeRatePct)} sub={takeDelta?.text} trend={takeDelta?.trend} />
        )}
        <StatCard label="Avg order" value={<Money amount={h.aov} />} sub={aovDelta?.text} trend={aovDelta?.trend} />
        <StatCard label="Paid sales" value={h.paidCount} sub={paidDelta?.text} trend={paidDelta?.trend} />
        <StatCard label="Unique buyers" value={h.uniqueBuyers} sub={buyersDelta?.text} trend={buyersDelta?.trend} />
      </StatGrid>

      <div className="stack">
        <div className="card">
          <div className="sechead row">
            <span>Revenue over time</span>
            <button className={`btn ghost tgl${metric === 'gross' ? ' active' : ''}`} onClick={() => setMetric('gross')}>Gross</button>
            <button className={`btn ghost tgl${metric === 'net' ? ' active' : ''}`} onClick={() => setMetric('net')}>Net</button>
          </div>
          <BarChart points={dailyBars(report.timeseries, dateWindow, metric)} currency={currency} />
        </div>

        <div className={parts.length ? 'grid2' : undefined}>
          {parts.length > 0 && (
          <div className="card">
            <div className="sechead">Where the money goes</div>
            <div className="wf-bar">
              {parts.map((part) => (
                <span key={part.label} className={part.tone} style={{ width: `${share(part.amount, distributed)}%` }} />
              ))}
            </div>
            {parts.map((part) => (
              <MetricRow
                key={part.label}
                label={part.label}
                sharePct={share(part.amount, distributed)}
                tone={part.tone}
                value={<><Money amount={part.amount} direction={part.direction} /> · {pct(share(part.amount, distributed))}</>}
              />
            ))}
          </div>
          )}

          <div className="card">
            <div className="sechead">Link funnel</div>
            <div className="funnel-step">
              <span className="flbl">Created</span>
              <div className="fbar" style={{ width: '100%' }}>{f.created}</div>
            </div>
            <div className="funnel-step">
              <span className="flbl">Paid</span>
              <div className="fbar" style={{ width: `${share(f.paid, f.created)}%` }}>{f.paid}</div>
            </div>
            <DetailRow label="Conversion">{pct(f.conversionPct)}</DetailRow>
            <DetailRow label="Declined">{pct(f.declinePct)}</DetailRow>
            <DetailRow label="Expired">{pct(f.expiryPct)}</DetailRow>
            <DetailRow label="Revenue per link"><Money amount={f.revenuePerLink} direction="in" /></DetailRow>
          </div>
        </div>

        {/* Both tables rank people against each other, so they belong to the
            roles that run the workspace. The server sends empty arrays to
            everyone else. */}
        {canScope && (
          <>
            <section>
              <div className="sechead">Agent leaderboard</div>
              <DataTable
                columns={agentColumns}
                rows={report.agents.map((r, i) => ({ ...r, rank: i + 1 }))}
                rowKey={(_, i) => String(i)}
                emptyTitle="No sales in this period."
              />
            </section>

            <section>
              <div className="sechead">Account performance</div>
              <DataTable
                columns={accountColumns}
                rows={report.accounts}
                rowKey={(_, i) => String(i)}
                emptyTitle="No sales in this period."
              />
            </section>
          </>
        )}

        <div className="grid2">
          <div className="card">
            <div className="sechead">Customer value</div>
            <StatGrid>
              <StatCard label="Avg LTV" value={<Money amount={cu.avgLtv} direction="in" />} />
              <StatCard label="ARPU" value={<Money amount={cu.arpu} direction="in" />} />
              <StatCard label="Repeat rate" value={pct(cu.repeatRatePct)} />
              <StatCard label="Buys per fan" value={cu.freq.toFixed(1)} />
            </StatGrid>
            <div className="sechead">Revenue concentration</div>
            <MetricRow label="Top 1% of fans" sharePct={cu.concentration.top1} value={`${pct(cu.concentration.top1)} of revenue`} />
            <MetricRow label="Top 5% of fans" sharePct={cu.concentration.top5} value={`${pct(cu.concentration.top5)} of revenue`} />
            <MetricRow label="Top 10% of fans" sharePct={cu.concentration.top10} value={`${pct(cu.concentration.top10)} of revenue`} />
          </div>

          <div className="card">
            <div className="sechead">Revenue by segment</div>
            {cu.segments.map((s) => (
              <MetricRow key={s.segment} label={s.segment} sharePct={share(s.revenue, segmentMax)} value={<Money amount={s.revenue} direction="in" />} />
            ))}
            <div className="sechead">New vs returning</div>
            <MetricRow
              label="New fans"
              sharePct={share(cu.newVsReturning.newRev, newVsReturningTotal)}
              value={<><Money amount={cu.newVsReturning.newRev} direction="in" /> · {pct(share(cu.newVsReturning.newRev, newVsReturningTotal))}</>}
            />
            <MetricRow
              label="Returning fans"
              sharePct={share(cu.newVsReturning.retRev, newVsReturningTotal)}
              value={<><Money amount={cu.newVsReturning.retRev} direction="in" /> · {pct(share(cu.newVsReturning.retRev, newVsReturningTotal))}</>}
            />
          </div>
        </div>

        <div className="card">
          <div className="sechead">Chargeback risk</div>
          {cb.ratePct > 1 && (
            <div className="warnbar">
              Chargeback rate is {pct(cb.ratePct)} — above the 1% threshold card networks monitor.
            </div>
          )}
          <StatGrid>
            <StatCard label="CB rate by count" value={pct(cb.ratePct)} />
            <StatCard label="CB rate by value" value={pct(cb.rateValuePct)} />
            <StatCard label="Fee cost" value={<Money amount={cb.feeCost} direction="out" />} />
            <StatCard label="Reversed value" value={<Money amount={cb.valueReversed} direction="out" />} />
          </StatGrid>
          {byBearer && (
            <>
              <div className="sechead">Who absorbs the loss</div>
              <MetricRow label="Accounts" sharePct={share(byBearer.account, lossTotal)} value={<Money amount={byBearer.account} direction="out" />} />
              <MetricRow label="Agency" sharePct={share(byBearer.agency, lossTotal)} value={<Money amount={byBearer.agency} direction="out" />} />
            </>
          )}
        </div>

        <div className="card">
          <div className="sechead">When fans buy — day × hour</div>
          <div className="tablewrap">
            <Heatmap grid={report.heatmap} currency={currency} />
          </div>
        </div>
      </div>
    </div>
  );
}
