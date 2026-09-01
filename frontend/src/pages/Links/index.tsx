import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDebounced } from '../../hooks/useDebounced';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useRateCard } from '../../hooks/useRateCard';
import { feeBreakdown } from '../../business/feeBreakdown';
import { formatMoney, sum } from '../../lib/format';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import {
  PageHeader, StatCard, StatGrid, Money, Pill, DateCell, CopyButton, DetailRow, Select,
  DataTable, FilterBar, Calendar, ViewPicker,
  type Column, type DateRange, type SortState,
} from '../../components/ui';
import { useViewLayout, orderBy } from '../../hooks/useViewLayout';
import {
  LINK_TYPES, LINK_TYPE_LABELS, LINK_STATUSES, LINK_STATUS_LABELS, isShareable,
  type PaymentLink, type LinkStatus, type LinkType, type LinkSort,
} from '../../api/endpoints';
import { useLinksData } from './useLinksData';
import { DEFAULT_FILTERS, hasActiveFilters, rangeIsInverted, type LinksFilters } from './filters';

const STATUS_TONE: Record<LinkStatus, 'ok' | 'no' | 'warn' | 'muted'> = {
  active: 'ok',
  pending: 'warn',
  done: 'ok',
  expired: 'muted',
  cancelled: 'muted',
  refunded: 'no',
};

export default function LinksPage() {
  const can = useCan();
  const { labels } = useCurrentSession();
  const { rateCard } = useRateCard();
  const canCreate = can('links.create');
  const canComplete = can('payments.complete');
  const [filters, setFilters] = useState<LinksFilters>(DEFAULT_FILTERS);

  const [sort, setSort] = useState<SortState>({ key: 'created', dir: 'desc' });
  // A fresh column starts at its most useful end: newest, largest, first status.
  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  // Sent to the server, not applied to the loaded page: the list is paginated.
  // The typed boxes are debounced so a keystroke — or a nudge of the amount
  // spinner — doesn't refetch the whole page.
  const search = useDebounced(filters.search, 300);
  const min = useDebounced(filters.min, 300);
  const max = useDebounced(filters.max, 300);
  const query = useMemo(() => ({
    status: filters.status || undefined,
    type: filters.type || undefined,
    min: min || undefined,
    max: max || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    q: search.trim() || undefined,
    accountId: filters.accountId || undefined,
    sort: sort.key as LinkSort,
    dir: sort.dir,
  }), [filters.status, filters.type, min, max, filters.from, filters.to, filters.accountId, search, sort]);

  const {
    links, accounts, linkLimits, isLoading, isError, hasMore, isLoadingMore, loadMore,
    createLink, cancelLink,
  } = useLinksData(query);
  const [createOpen, setCreateOpen] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [type, setType] = useState<LinkType>('single_use');
  const [amountText, setAmountText] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [detail, setDetail] = useState<PaymentLink | null>(null);
  const [cancelling, setCancelling] = useState<PaymentLink | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  const paid = links.filter((l) => l.status === 'pending' || l.status === 'done');
  const conversion = links.length ? Math.round((paid.length / links.length) * 100) : 0;
  const revenue = sum(paid.map((l) => l.amount ?? 0));
  const statsUnknown = isLoading || isError;

  const range: DateRange = { from: filters.from, to: filters.to };
  const setRange = (r: DateRange) => setFilters((f) => ({ ...f, ...r }));

  const statCards = [
    { key: 'links', label: 'Links', card: <StatCard isUnknown={statsUnknown} label="Links" value={links.length} sub={hasMore ? 'Loaded so far' : 'Matching'} /> },
    { key: 'paid', label: 'Paid', card: <StatCard isUnknown={statsUnknown} label="Paid" value={paid.length} sub="Single-use links paid" /> },
    { key: 'conversion', label: 'Conversion', card: <StatCard isUnknown={statsUnknown} label="Conversion" value={`${conversion}%`} sub="Paid ÷ links" /> },
    { key: 'revenue', label: 'Revenue', card: <StatCard isUnknown={statsUnknown} label="Revenue" value={<Money amount={revenue} direction="in" emphasis />} sub="From paid links" /> },
  ];
  const statsView = useViewLayout('links.stats', statCards);

  const activeAccounts = accounts.filter((a) => a.status === 'active');
  const inverted = rangeIsInverted(filters);

  const minAmount = linkLimits?.minLinkAmount ?? linkLimits?.providerMinimum ?? 0;
  const maxAmount = linkLimits?.maxLinkAmount ?? null;
  const amount = parseFloat(amountText) || 0;
  const belowMin = amount > 0 && amount < minAmount;
  const aboveMax = maxAmount != null && amount > maxAmount;
  const fees = amount > 0 && !belowMin && !aboveMax ? feeBreakdown(amount, rateCard) : null;

  const openCreate = () => {
    setAccountId(activeAccounts[0]?.id ?? '');
    setType('single_use');
    setAmountText('');
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    if (!accountId) { toast(`Pick a ${labels.account.toLowerCase()}.`); return; }
    if (!(amount >= minAmount)) { toast(`Minimum link amount is ${formatMoney(minAmount)}.`); return; }
    if (aboveMax) { toast(`Maximum link amount is ${formatMoney(maxAmount ?? 0)}.`); return; }
    setIsCreating(true);
    try {
      const created = await createLink({ accountId, type, amount });
      setCreateOpen(false);
      setCreatedUrl(created.checkoutUrl);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the link.');
    } finally {
      setIsCreating(false);
    }
  };

  const confirmCancel = async (l: PaymentLink) => {
    setIsCancelling(true);
    try {
      await cancelLink(l.id);
      setCancelling(null);
      setDetail(null);
      toast('Link cancelled.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not cancel the link.');
    } finally {
      setIsCancelling(false);
    }
  };

  const columns: Column<PaymentLink>[] = [
    { key: 'ref', header: 'Ref', render: (l) => <span className="ref" title={l.referenceId}>{l.referenceId}</span> },
    {
      key: 'type', header: 'Type', render: (l) => <Pill>{LINK_TYPE_LABELS[l.type]}</Pill>,
      isFiltered: filters.type !== '',
      filter: (
        <Select label="Type" hideLabel value={filters.type} onChange={(v) => setFilters((f) => ({ ...f, type: v as LinksFilters['type'] }))}>
          <option value="">All types</option>
          {LINK_TYPES.map((t) => <option key={t} value={t}>{LINK_TYPE_LABELS[t]}</option>)}
        </Select>
      ),
    },
    {
      key: 'account', header: labels.account, render: (l) => l.account,
      isFiltered: filters.accountId !== '',
      filter: (
        <Select label={labels.account} hideLabel value={filters.accountId} onChange={(v) => setFilters((f) => ({ ...f, accountId: v }))}>
          <option value="">All {labels.accounts.toLowerCase()}</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      ),
    },
    { key: 'agent', header: labels.agent, render: (l) => l.agent ?? '—' },
    {
      key: 'amount', header: 'Amount', sortKey: 'amount',
      render: (l) => l.amount == null ? '—' : <Money amount={l.amount} currency={l.currency} />,
      isFiltered: filters.min !== '' || filters.max !== '',
      filter: (
        <div className="field-row">
          <input type="number" className="amount-input" aria-label="Minimum amount" placeholder="Min" value={filters.min}
            aria-invalid={inverted || undefined} onChange={(e) => setFilters((f) => ({ ...f, min: e.target.value }))} />
          <input type="number" className="amount-input" aria-label="Maximum amount" placeholder="Max" value={filters.max}
            aria-invalid={inverted || undefined} onChange={(e) => setFilters((f) => ({ ...f, max: e.target.value }))} />
        </div>
      ),
    },
    {
      key: 'status', header: 'Status', sortKey: 'status',
      render: (l) => <Pill tone={STATUS_TONE[l.status]}>{LINK_STATUS_LABELS[l.status]}</Pill>,
      isFiltered: filters.status !== '',
      filter: (
        <Select label="Status" hideLabel value={filters.status} onChange={(v) => setFilters((f) => ({ ...f, status: v as LinksFilters['status'] }))}>
          <option value="">All statuses</option>
          {LINK_STATUSES.map((st) => <option key={st} value={st}>{LINK_STATUS_LABELS[st]}</option>)}
        </Select>
      ),
    },
    {
      key: 'created', header: 'Created', sortKey: 'created', render: (l) => <DateCell ts={l.createdAt} />,
      isFiltered: filters.from !== '' || filters.to !== '',
      filter: <Calendar value={range} onChange={setRange} />,
    },
  ];

  const columnsView = useViewLayout('links.columns', columns.map((c) => ({ key: c.key, label: c.header })));
  const shownColumns: Column<PaymentLink>[] = [
    ...orderBy(columns, columnsView.visibleKeys),
    // The actions cell is a control, not data: it is never hidden or moved.
    {
      key: 'actions', header: 'Actions', hideHeader: true, align: 'right',
      render: (l: PaymentLink) => (
        <div className="cell-actions">
          {isShareable(l.status) && l.checkoutUrl && <CopyButton value={l.checkoutUrl} label="Copy" small />}
          {isShareable(l.status) && canCreate && <button className="btn ghost small" onClick={() => setCancelling(l)}>Cancel</button>}
          {l.status === 'pending' && canComplete && (
            <Link className="btn ghost small" to={`/payments?needs_details=1&q=${encodeURIComponent(l.referenceId)}`}>Complete</Link>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Payment links"
        actions={
          <>
            <ViewPicker label="Edit cards" view={statsView} />
            {canCreate && <button className="btn" onClick={openCreate}>New link</button>}
          </>
        }
      />

      {isError && (
        <div className="warnbar" role="alert">
          Couldn't load payment links. The figures below are incomplete — reload to try again.
        </div>
      )}
      {inverted && (
        <div className="warnbar" role="alert">
          The maximum amount is below the minimum, so nothing can match. Swap them or clear one.
        </div>
      )}

      <StatGrid>
        {orderBy(statCards, statsView.visibleKeys).map((c) => <Fragment key={c.key}>{c.card}</Fragment>)}
      </StatGrid>

      <FilterBar>
        <input type="search" className="search-input" aria-label="Search links" placeholder="Search ref, agent"
          value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
        <button className="btn ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</button>
        <ViewPicker label="Edit columns" view={columnsView} />
      </FilterBar>

      <DataTable
        columns={shownColumns}
        rows={links}
        rowKey={(l) => l.id}
        onRowClick={setDetail}
        sort={sort}
        onSort={toggleSort}
        isLoading={isLoading}
        emptyTitle={isError ? "Couldn't load payment links." : 'No links match these filters.'}
        emptyHint={isError ? 'Try again in a moment.' : canCreate ? 'Create one from the header.' : `Ask a ${labels.agent.toLowerCase()} to create one.`}
        footer={
          <span className="table-foot-row">
            {hasActiveFilters(filters) ? 'Matching links' : 'All links'}: {links.length} loaded
            {hasMore && (
              <button className="btn ghost small" onClick={loadMore} disabled={isLoadingMore}>
                {isLoadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </span>
        }
      />

      <Modal open={detail !== null && cancelling === null} onClose={() => setDetail(null)} title="Payment link">
        {detail && (
          <>
            <div className="modal-topline">
              <span className="ref">{detail.referenceId}</span>
              <Pill tone={STATUS_TONE[detail.status]}>{LINK_STATUS_LABELS[detail.status]}</Pill>
            </div>
            <DetailRow label="Type">{LINK_TYPE_LABELS[detail.type]}</DetailRow>
            <DetailRow label={labels.account}>{detail.account}</DetailRow>
            <DetailRow label={labels.agent}>{detail.agent ?? '—'}</DetailRow>
            <DetailRow label="Amount">{detail.amount == null ? '—' : <Money amount={detail.amount} currency={detail.currency} emphasis />}</DetailRow>
            <DetailRow label="Created"><DateCell ts={detail.createdAt} /></DetailRow>
            {detail.paidAt && <DetailRow label="Paid"><DateCell ts={detail.paidAt} /></DetailRow>}
            {isShareable(detail.status) && detail.checkoutUrl && (
              <div className="field">
                <label htmlFor="detail-url">Checkout URL</label>
                <div className="field-row">
                  <input id="detail-url" type="text" readOnly value={detail.checkoutUrl} onFocus={(e) => e.target.select()} />
                  <CopyButton value={detail.checkoutUrl} />
                </div>
              </div>
            )}
            {detail.status === 'pending' && (
              <div className="callout">
                <p className="sub">The customer has paid. The payment needs its details — who paid and what for — before it counts as revenue.</p>
              </div>
            )}
            <div className="modal-actions">
              {detail.status === 'pending' && canComplete && (
                <Link className="btn" to={`/payments?needs_details=1&q=${encodeURIComponent(detail.referenceId)}`}>Complete on Payments</Link>
              )}
              {isShareable(detail.status) && canCreate && (
                <button className="btn danger" onClick={() => setCancelling(detail)}>Cancel link</button>
              )}
              <span className="spacer" />
              <button className="btn ghost" onClick={() => setDetail(null)}>Close</button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New payment link">
        <Select id="link-account" label={labels.account} value={accountId} onChange={setAccountId}>
          {activeAccounts.length === 0 && <option value="">No active {labels.accounts.toLowerCase()}</option>}
          {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Select id="link-type" label="Type" value={type} onChange={(v) => setType(v as LinkType)}
          hint={type === 'single_use'
            ? 'Closes on the first payment, or after 24 hours if nobody pays.'
            : 'Stays open through any number of payments until you cancel it.'}>
          {LINK_TYPES.map((t) => <option key={t} value={t}>{LINK_TYPE_LABELS[t]}</option>)}
        </Select>
        <div className="field">
          <label htmlFor="link-amount">Amount</label>
          <input id="link-amount" type="number" min={minAmount} max={maxAmount ?? undefined} step={0.01} placeholder="0.00"
            value={amountText} onChange={(e) => setAmountText(e.target.value)} />
          <p className="sub">
            {belowMin ? <span className="text-neg">Below the {formatMoney(minAmount)} minimum.</span>
              : aboveMax ? <span className="text-neg">Above the {formatMoney(maxAmount ?? 0)} maximum.</span>
                : [`Minimum ${formatMoney(minAmount)}`, maxAmount != null ? `Maximum ${formatMoney(maxAmount)}` : null].filter(Boolean).join(' · ')}
          </p>
        </div>

        <div className={`pl-fees${fees && fees.effectivePct >= 18 ? ' hot' : fees && fees.effectivePct >= 15 ? ' warm' : ''}`}>
          <div className="fee-line">
            <span>Platform fee ({rateCard.blended.toFixed(1)}%)</span>
            <b className="fee-val">{fees ? formatMoney(fees.blendedFee) : '—'}</b>
          </div>
          <div className="fee-line">
            <span>Transaction fee</span>
            <b className="fee-val">{fees ? formatMoney(fees.fixed) : '—'}</b>
          </div>
          <div className="fee-tot">
            <span>Total fees</span>
            <span className="fee-val">{fees ? formatMoney(fees.total) : '—'}</span>
          </div>
          <div className="fee-net">
            <span>Net profit</span>
            <span className="fee-val">{fees ? formatMoney(fees.net) : '—'}</span>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setCreateOpen(false)}>Cancel</button>
          <button className="btn" onClick={submitCreate} disabled={isCreating || !accountId}>
            {isCreating ? 'Creating…' : 'Create link'}
          </button>
        </div>
      </Modal>

      <Modal open={createdUrl !== null} onClose={() => setCreatedUrl(null)} title="Link ready"
        subtitle="Copy this URL and send it to the customer through whichever channel you use.">
        {createdUrl && (
          <>
            <div className="field">
              <label htmlFor="created-url">Checkout URL</label>
              <input id="created-url" type="text" readOnly value={createdUrl} onFocus={(e) => e.target.select()} />
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setCreatedUrl(null)}>Close</button>
              <CopyButton value={createdUrl} label="Copy link" primary />
            </div>
          </>
        )}
      </Modal>

      <Modal open={cancelling !== null} onClose={() => setCancelling(null)}
        title={cancelling ? `Cancel link ${cancelling.referenceId}?` : ''}
        subtitle="The checkout URL stops working immediately. Money already taken on it is untouched.">
        {cancelling && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setCancelling(null)}>Keep it</button>
            <button className="btn danger" disabled={isCancelling} onClick={() => confirmCancel(cancelling)}>
              {isCancelling ? 'Cancelling…' : 'Cancel link'}
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
