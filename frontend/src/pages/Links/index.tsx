import { useMemo, useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { useRateCard } from '../../hooks/useRateCard';
import { feeBreakdown } from '../../business/feeBreakdown';
import { formatMoney, sum } from '../../lib/format';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import {
  PageHeader, StatCard, StatGrid, Money, Pill, DateCell,
  DataTable, FilterBar, DateRangePicker, type Column, type DateRange,
} from '../../components/ui';
import {
  LINK_STATUSES, LINK_STATUS_LABELS, canTakeLinks, type PaymentLink, type LinkStatus,
} from '../../api/endpoints';
import { useLinksData } from './useLinksData';
import { filterLinks, DEFAULT_FILTERS, type LinksFilters } from './filters';

const STATUS_TONE: Record<LinkStatus, 'ok' | 'no' | 'muted'> = {
  created: 'muted',
  opened: 'muted',
  paid: 'ok',
  failed: 'no',
  expired: 'muted',
  refunded: 'no',
};

export default function LinksPage() {
  const can = useCan();
  const { rateCard } = useRateCard();
  const { links, creators, customers, linkLimits, isLoading, isError, createLink, reconcile } = useLinksData();

  const [filters, setFilters] = useState<LinksFilters>(DEFAULT_FILTERS);
  const [createOpen, setCreateOpen] = useState(false);
  const [creatorId, setCreatorId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);

  const filtered = useMemo(() => filterLinks(links, filters), [links, filters]);
  const paid = filtered.filter((l) => l.status === 'paid');
  const conversion = filtered.length ? Math.round((paid.length / filtered.length) * 100) : 0;
  const revenue = sum(paid.map((l) => l.amount ?? 0));

  const range: DateRange = { from: filters.from, to: filters.to };
  const setRange = (r: DateRange) => setFilters((f) => ({ ...f, ...r }));

  const activeCreators = creators.filter((c) => canTakeLinks(c.status));
  const creatorNames = [...new Set(links.map((l) => l.creator).filter((n): n is string => Boolean(n)))];

  const minAmount = linkLimits?.minLinkAmount ?? linkLimits?.providerMinimum ?? 0;
  const maxAmount = linkLimits?.maxLinkAmount ?? null;
  const amount = parseFloat(amountText) || 0;
  const belowMin = amount > 0 && amount < minAmount;
  const aboveMax = maxAmount != null && amount > maxAmount;
  const fees = amount > 0 && !belowMin && !aboveMax ? feeBreakdown(amount, rateCard) : null;

  const openCreate = () => {
    setCreatorId(activeCreators[0]?.id ?? '');
    setCustomerId('');
    setAmountText('');
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    if (!creatorId) { toast('Pick a creator.'); return; }
    if (!(amount >= minAmount)) { toast(`Minimum link amount is ${formatMoney(minAmount)}.`); return; }
    if (aboveMax) { toast(`Maximum link amount is ${formatMoney(maxAmount ?? 0)}.`); return; }
    setIsCreating(true);
    try {
      const created = await createLink({ creatorId, customerId: customerId || undefined, amount });
      setCreateOpen(false);
      setCreatedUrl(created.url);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the link.');
    } finally {
      setIsCreating(false);
    }
  };

  const runReconcile = async () => {
    setIsReconciling(true);
    try {
      const result = await reconcile();
      toast(`Checked ${result.checked} links, updated ${result.updated}.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Reconcile failed.');
    } finally {
      setIsReconciling(false);
    }
  };

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied.');
    } catch {
      toast('Could not copy. Select the link and copy it manually.');
    }
  };

  const columns: Column<PaymentLink>[] = [
    { key: 'ref', header: 'Ref', render: (l) => <span className="ref">{l.referenceId}</span> },
    { key: 'creator', header: 'Creator', render: (l) => l.creator ?? '—' },
    { key: 'chatter', header: 'Chatter', render: (l) => l.chatter ?? '—' },
    { key: 'customer', header: 'Customer', render: (l) => <span className="cname">{l.customer ?? '—'}</span> },
    { key: 'amount', header: 'Amount', align: 'right', render: (l) => l.amount == null ? '—' : <Money amount={l.amount} currency={l.currency} /> },
    { key: 'status', header: 'Status', render: (l) => <Pill tone={STATUS_TONE[l.status]}>{LINK_STATUS_LABELS[l.status]}</Pill> },
    { key: 'created', header: 'Created', render: (l) => <DateCell ts={l.createdAt} /> },
    { key: 'paid', header: 'Paid', render: (l) => <DateCell ts={l.paidAt} /> },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Money in"
        title="Payment links"
        subtitle="Hosted checkout links. The customer pays on MantaPay's page; card details never touch this system."
        actions={
          <>
            {can('commissions.manage') && (
              <button className="btn ghost" onClick={runReconcile} disabled={isReconciling}>
                {isReconciling ? 'Reconciling…' : 'Reconcile'}
              </button>
            )}
            {can('links.create') && (
              <button className="btn" onClick={openCreate}>New link</button>
            )}
          </>
        }
      />

      <StatGrid>
        <StatCard label="Links" value={filtered.length} sub="In view" />
        <StatCard label="Paid" value={paid.length} sub="Conversions" />
        <StatCard label="Conversion" value={`${conversion}%`} sub="Paid ÷ links" />
        <StatCard label="Revenue" value={<Money amount={revenue} direction="in" emphasis />} sub="From paid links" />
      </StatGrid>

      <FilterBar>
        <select value={filters.creator} onChange={(e) => setFilters((f) => ({ ...f, creator: e.target.value }))}>
          <option value="">All creators</option>
          {creatorNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as LinksFilters['status'] }))}
        >
          <option value="">All statuses</option>
          {LINK_STATUSES.map((s) => <option key={s} value={s}>{LINK_STATUS_LABELS[s]}</option>)}
        </select>
        <input
          type="number" className="amount-input" placeholder="Min" value={filters.min}
          onChange={(e) => setFilters((f) => ({ ...f, min: e.target.value }))}
        />
        <input
          type="number" className="amount-input" placeholder="Max" value={filters.max}
          onChange={(e) => setFilters((f) => ({ ...f, max: e.target.value }))}
        />
        <DateRangePicker value={range} onChange={setRange} />
        <input
          type="search" className="search-input" placeholder="Search ref, customer, chatter" value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
        />
        <button className="btn ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear</button>
      </FilterBar>

      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(l) => l.id}
        isLoading={isLoading}
        emptyTitle={isError ? "Couldn't load payment links." : 'No links match these filters.'}
        emptyHint={isError ? 'Try again in a moment.' : can('links.create') ? 'Create one from the header.' : 'Ask a chatter to create one.'}
        footer={`Showing ${filtered.length} of ${links.length}`}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)}>
        <h3>New payment link</h3>
        <p className="sub">The customer pays on MantaPay's hosted page. The amount is fixed in the link.</p>
        <div className="field">
          <label htmlFor="link-creator">Creator</label>
          <select id="link-creator" value={creatorId} onChange={(e) => setCreatorId(e.target.value)}>
            {activeCreators.length === 0 && <option value="">No active creators</option>}
            {activeCreators.map((c) => <option key={c.id} value={c.id}>{c.stageName}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="link-customer">Customer</label>
          <select id="link-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Not recorded</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.alias}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="link-amount">Amount</label>
          <input
            id="link-amount"
            type="number"
            min={minAmount}
            max={maxAmount ?? undefined}
            step={0.01}
            placeholder="0.00"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
          />
          <p className="sub">
            {belowMin ? <span className="text-neg">Below the {formatMoney(minAmount)} minimum.</span>
              : aboveMax ? <span className="text-neg">Above the {formatMoney(maxAmount ?? 0)} maximum.</span>
                : [
                    `Minimum ${formatMoney(minAmount)}`,
                    maxAmount != null ? `Maximum ${formatMoney(maxAmount)}` : null,
                  ].filter(Boolean).join(' · ')}
          </p>
        </div>

        <div className={`pl-fees${fees && fees.effectivePct >= 18 ? ' hot' : fees && fees.effectivePct >= 15 ? ' warm' : ''}`}>
          <div className="pl-fees-head">
            <span className="sub">Fees on this link</span>
            <span className="pl-fee-pct">{fees ? `${fees.effectivePct.toFixed(1)}%` : '—'}</span>
          </div>
          <div className="fee-line">
            <span>Platform fee ({rateCard.blended.toFixed(1)}%)</span>
            <b className="fee-val">{fees ? formatMoney(fees.blendedFee) : '—'}</b>
          </div>
          <div className="fee-line">
            <span>Fixed per transaction</span>
            <b className="fee-val">{fees ? formatMoney(fees.fixed) : '—'}</b>
          </div>
          {fees?.pspFee != null && fees.marginFee != null && (
            <>
              <div className="fee-line fee-line-sub">
                <span>PSP cost ({fees.pspPct}%)</span>
                <b className="fee-val">{formatMoney(fees.pspFee)}</b>
              </div>
              <div className="fee-line fee-line-sub">
                <span>HigherPays margin ({fees.marginPct}%)</span>
                <b className="fee-val">{formatMoney(fees.marginFee)}</b>
              </div>
            </>
          )}
          <div className="fee-tot">
            <span>Total fees</span>
            <span className="fee-val">{fees ? formatMoney(fees.total) : '—'}</span>
          </div>
          <div className="fee-net">
            <span>Net to workspace</span>
            <span className="fee-val">{fees ? formatMoney(fees.net) : '—'}</span>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setCreateOpen(false)}>Cancel</button>
          <button className="btn" onClick={submitCreate} disabled={isCreating || !creatorId}>
            {isCreating ? 'Creating…' : 'Create link'}
          </button>
        </div>
      </Modal>

      <Modal open={createdUrl !== null} onClose={() => setCreatedUrl(null)}>
        {createdUrl && (
          <>
            <h3>Link ready</h3>
            <p className="sub">Share this URL with the customer. It expires if it is not paid in time.</p>
            <div className="field">
              <label htmlFor="created-url">Checkout URL</label>
              <input id="created-url" type="text" readOnly value={createdUrl} onFocus={(e) => e.target.select()} />
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setCreatedUrl(null)}>Close</button>
              <button className="btn" onClick={() => copyUrl(createdUrl)}>Copy link</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
