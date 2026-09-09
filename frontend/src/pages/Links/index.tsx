import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useDebounced } from '../../hooks/useDebounced';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useRateCard } from '../../hooks/useRateCard';
import { feeBreakdown } from '../../business/feeBreakdown';
import { formatMoney } from '../../lib/format';
import Modal from '../../components/Modal';
import ReassignFields from '../../components/ReassignFields';
import { toast } from '../../lib/toast';
import {
  PageHeader, StatCard, StatGrid, Money, Pill, DateCell, CopyButton, DetailRow, Select,
  DataTable, FilterBar, DateRangePicker, ViewPicker,
  type Column, type DateRange, type SortState,
} from '../../components/ui';
import { useViewLayout, orderBy } from '../../hooks/useViewLayout';
import {
  LINK_TYPES, LINK_TYPE_LABELS, LINK_STATUSES, LINK_STATUS_LABELS,
  PROVIDER_ATTEMPT_STATUSES, PROVIDER_ATTEMPT_STATUS_LABELS, isShareable,
  type PaymentLink, type LinkEventType, type LinkStatus, type LinkType, type LinkSort, type ProviderAttemptStatus,
} from '../../api/endpoints';
import { useLinkDetail, useLinksData } from './useLinksData';
import { DEFAULT_FILTERS, hasActiveFilters, rangeIsInverted, type LinksFilters } from './filters';

const STATUS_TONE: Record<LinkStatus, 'ok' | 'no' | 'warn' | 'muted'> = {
  active: 'ok',
  pending: 'warn',
  done: 'ok',
  expired: 'muted',
  cancelled: 'muted',
  refunded: 'no',
};

const PROVIDER_STATUS_TONE: Record<ProviderAttemptStatus, 'ok' | 'no' | 'warn'> = {
  approved: 'ok',
  pending: 'warn',
  declined: 'no',
};

const EVENT_LABELS: Record<LinkEventType, string> = {
  created: 'Created',
  opened: 'Checkout opened',
  checkout_initiated: 'Checkout initiated',
  checkout_redirected: 'Redirect produced',
  provider_pending: 'Provider pending',
  provider_approved: 'Provider approved',
  provider_declined: 'Provider declined',
  details_completed: 'Details completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  refunded: 'Refunded',
  chargeback: 'Chargeback',
};

export default function LinksPage() {
  const can = useCan();
  const { labels } = useCurrentSession();
  const { rateCard } = useRateCard();
  const canCreate = can('links.create');
  const canComplete = can('payments.complete');
  const canReassign = can('revenue.manage');
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<LinksFilters>(() => ({
    ...DEFAULT_FILTERS,
    search: params.get('q') ?? '',
  }));

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
    providerStatus: filters.providerStatus || undefined,
    showArchived: filters.showArchived || undefined,
    sort: sort.key as LinkSort,
    dir: sort.dir,
  }), [filters.status, filters.type, min, max, filters.from, filters.to, filters.accountId, filters.providerStatus, filters.showArchived, search, sort]);

  const {
    links, summary, accounts, linkLimits, isLoading, isError, isSummaryLoading, isSummaryError, hasMore, isLoadingMore, loadMore,
    createLink, cancelLink, updateNote, setArchived, reassignLink,
  } = useLinksData(query);
  const [createOpen, setCreateOpen] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [type, setType] = useState<LinkType>('single_use');
  const [amountText, setAmountText] = useState('');
  const [description, setDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [detail, setDetail] = useState<PaymentLink | null>(null);
  const detailQuery = useLinkDetail(detail?.id ?? null);
  const detailData = detailQuery.data ?? detail;
  const [detailNote, setDetailNote] = useState('');
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [cancelling, setCancelling] = useState<PaymentLink | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  const conversion = summary?.totalLinks ? Math.round((summary.paidLinks / summary.totalLinks) * 100) : 0;
  const statsUnknown = isSummaryLoading || isSummaryError || !summary;

  const range: DateRange = { from: filters.from, to: filters.to };
  const setRange = (r: DateRange) => setFilters((f) => ({ ...f, ...r }));

  const statCards = [
    { key: 'links', label: 'Links', card: <StatCard isUnknown={statsUnknown} label="Links" value={summary?.totalLinks ?? 0} sub="Matching links" /> },
    { key: 'paid', label: 'Paid links', card: <StatCard isUnknown={statsUnknown} label="Paid links" value={summary?.paidLinks ?? 0} sub={`${conversion}% conversion`} /> },
    { key: 'payments', label: 'Successful payments', card: <StatCard isUnknown={statsUnknown} label="Successful payments" value={summary?.successfulPayments ?? 0} sub="Reusable payments count separately" /> },
    { key: 'gross', label: 'Gross sales', card: <StatCard isUnknown={statsUnknown} label="Gross sales" value={<Money amount={summary?.grossSales ?? 0} currency={summary?.currency} direction="in" />} sub="Content sales" /> },
    { key: 'net', label: 'Net after fees', card: <StatCard isUnknown={statsUnknown} label="Net after fees" value={<Money amount={summary?.netAfterFees ?? 0} currency={summary?.currency} direction="in" emphasis />} sub="Gross less platform fees" /> },
  ];
  const statsView = useViewLayout('links.stats', statCards);

  const activeAccounts = accounts.filter((a) => a.status === 'active');
  // A paused creator can still take over past money; an archived one cannot.
  const reassignableAccounts = accounts.filter((a) => a.status !== 'archived');
  const inverted = rangeIsInverted(filters);

  const minAmount = linkLimits?.minLinkAmount ?? linkLimits?.providerMinimum ?? 0;
  const expiryHours = Math.round((linkLimits?.linkTtlMinutes ?? 24 * 60) / 60);
  const maxAmount = linkLimits?.maxLinkAmount ?? null;
  const amount = parseFloat(amountText) || 0;
  const belowMin = amount > 0 && amount < minAmount;
  const aboveMax = maxAmount != null && amount > maxAmount;
  const fees = amount > 0 && !belowMin && !aboveMax ? feeBreakdown(amount, rateCard) : null;

  const openCreate = () => {
    setAccountId(activeAccounts[0]?.id ?? '');
    setType('single_use');
    setAmountText('');
    setDescription('');
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    if (!accountId) { toast(`Pick a ${labels.account.toLowerCase()}.`); return; }
    if (!(amount >= minAmount)) { toast(`Minimum link amount is ${formatMoney(minAmount)}.`); return; }
    if (aboveMax) { toast(`Maximum link amount is ${formatMoney(maxAmount ?? 0)}.`); return; }
    setIsCreating(true);
    try {
      const created = await createLink({ accountId, type, amount, description: description.trim() || undefined });
      setCreateOpen(false);
      setCreatedUrl(created.checkoutUrl);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the link.');
    } finally {
      setIsCreating(false);
    }
  };

  const openDetail = (link: PaymentLink) => {
    setDetail(link);
    setDetailNote(link.description ?? '');
  };

  const saveNote = async () => {
    if (!detailData) return;
    setIsSavingNote(true);
    try {
      await updateNote(detailData.id, detailNote);
      toast('Internal note saved.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the note.');
    } finally {
      setIsSavingNote(false);
    }
  };

  const changeArchived = async (link: PaymentLink, archived: boolean) => {
    try {
      await setArchived(link.id, archived);
      setDetail(null);
      toast(archived ? 'Link archived.' : 'Link restored.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the link.');
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
    {
      key: 'ref', header: 'HigherPays Order', render: (l) => (
        <div>
          <span className="ref" title={l.referenceId}>{l.referenceId}</span>
          {l.archivedAt && <div className="sub">Archived</div>}
        </div>
      ),
    },
    { key: 'type', header: 'Type', render: (l) => <Pill>{LINK_TYPE_LABELS[l.type]}</Pill> },
    { key: 'account', header: labels.account, render: (l) => l.account },
    { key: 'agent', header: labels.agent, render: (l) => l.agent ?? '—' },
    {
      key: 'amount', header: 'Amount', sortKey: 'amount',
      render: (l) => l.amount == null ? '—' : <Money amount={l.amount} currency={l.currency} />,
    },
    {
      key: 'status', header: 'Status', sortKey: 'status',
      render: (l) => <Pill tone={STATUS_TONE[l.status]}>{LINK_STATUS_LABELS[l.status]}</Pill>,
    },
    {
      key: 'provider', header: 'Provider attempt',
      render: (l) => l.latestProviderAttempt ? (
        <div>
          <Pill tone={PROVIDER_STATUS_TONE[l.latestProviderAttempt.status]}>
            {PROVIDER_ATTEMPT_STATUS_LABELS[l.latestProviderAttempt.status]}
          </Pill>
          <div className="sub">
            {[l.latestProviderAttempt.replyCode, l.latestProviderAttempt.replyDescription].filter(Boolean).join(' · ') || 'No reply details'}
            {' · '}<DateCell ts={l.latestProviderAttempt.occurredAt} />
          </div>
        </div>
      ) : '—',
    },
    { key: 'created', header: 'Created', sortKey: 'created', render: (l) => <DateCell ts={l.createdAt} /> },
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

      {(isError || isSummaryError) && (
        <div className="warnbar" role="alert">
          Couldn't load all payment-link data. Reload to try again.
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
      {summary && (
        <div className="callout price-bands">
          <span className="field-label">Link price bands</span>
          {summary.priceBands.map((band) => (
            <span key={band.min} className="sub">
              {band.max == null ? `${band.min}+` : `${band.min}–<${band.max}`}: <b>{band.count}</b>
            </span>
          ))}
        </div>
      )}

      <FilterBar>
        <input type="search" className="search-input" aria-label="Search links" placeholder="Search HigherPays Order, MantaPay ID, agent"
          value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
        <Select label="Type" hideLabel value={filters.type} onChange={(v) => setFilters((f) => ({ ...f, type: v as LinksFilters['type'] }))}>
          <option value="">All types</option>
          {LINK_TYPES.map((t) => <option key={t} value={t}>{LINK_TYPE_LABELS[t]}</option>)}
        </Select>
        <Select label="Status" hideLabel value={filters.status} onChange={(v) => setFilters((f) => ({ ...f, status: v as LinksFilters['status'] }))}>
          <option value="">All statuses</option>
          {LINK_STATUSES.map((status) => <option key={status} value={status}>{LINK_STATUS_LABELS[status]}</option>)}
        </Select>
        <Select label="Provider attempt" hideLabel value={filters.providerStatus}
          onChange={(v) => setFilters((f) => ({ ...f, providerStatus: v as LinksFilters['providerStatus'] }))}>
          <option value="">All provider attempts</option>
          {PROVIDER_ATTEMPT_STATUSES.map((status) => <option key={status} value={status}>{PROVIDER_ATTEMPT_STATUS_LABELS[status]}</option>)}
        </Select>
        <Select label={labels.account} hideLabel value={filters.accountId} onChange={(v) => setFilters((f) => ({ ...f, accountId: v }))}>
          <option value="">All {labels.accounts.toLowerCase()}</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
        </Select>
        <DateRangePicker value={range} onChange={setRange} />
        <div className="field-row">
          <input type="number" className="amount-input" aria-label="Minimum amount" placeholder="Min amount" value={filters.min}
            aria-invalid={inverted || undefined} onChange={(e) => setFilters((f) => ({ ...f, min: e.target.value }))} />
          <input type="number" className="amount-input" aria-label="Maximum amount" placeholder="Max amount" value={filters.max}
            aria-invalid={inverted || undefined} onChange={(e) => setFilters((f) => ({ ...f, max: e.target.value }))} />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={filters.showArchived}
            onChange={(e) => setFilters((f) => ({ ...f, showArchived: e.target.checked }))} />
          <span>Show archived</span>
        </label>
        <button className="btn ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear filters</button>
        <ViewPicker label="Edit columns" view={columnsView} />
      </FilterBar>

      <DataTable
        columns={shownColumns}
        rows={links}
        rowKey={(l) => l.id}
        onRowClick={openDetail}
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
        {detailQuery.isError && <div className="warnbar" role="alert">Couldn't load the full link history. Try again.</div>}
        {detailData && (
          <>
            <div className="modal-topline">
              <Pill tone={STATUS_TONE[detailData.status]}>{LINK_STATUS_LABELS[detailData.status]}</Pill>
              {detailData.archivedAt && <Pill tone="muted">Archived</Pill>}
            </div>
            <DetailRow label="HigherPays Order"><span className="ref">{detailData.referenceId}</span></DetailRow>
            <DetailRow label="Type">{LINK_TYPE_LABELS[detailData.type]}</DetailRow>
            {canReassign && detailData.status !== 'refunded' ? (
              <ReassignFields
                key={detailData.id}
                kind="link"
                id={detailData.id}
                accountId={detailData.accountId}
                agentId={detailData.agentId}
                accounts={reassignableAccounts}
                onSave={async (input) => {
                  await reassignLink(detailData.id, input);
                  setDetail(null);
                  toast('Link reassigned.');
                }}
              />
            ) : (
              <>
                <DetailRow label={labels.account}>{detailData.account}</DetailRow>
                <DetailRow label={labels.agent}>{detailData.agent ?? '—'}</DetailRow>
              </>
            )}
            <DetailRow label="Amount">{detailData.amount == null ? '—' : <Money amount={detailData.amount} currency={detailData.currency} emphasis />}</DetailRow>
            <DetailRow label="Created"><DateCell ts={detailData.createdAt} /></DetailRow>
            {detailData.paidAt && <DetailRow label="Paid"><DateCell ts={detailData.paidAt} /></DetailRow>}
            {detailQuery.data && (
              <>
                <DetailRow label="Checkout opens">{detailQuery.data.openCount}</DetailRow>
                <DetailRow label="First opened"><DateCell ts={detailQuery.data.firstOpenedAt} /></DetailRow>
                <DetailRow label="Last opened"><DateCell ts={detailQuery.data.lastOpenedAt} /></DetailRow>
              </>
            )}
            {detailData.latestProviderAttempt && (
              <>
                <DetailRow label="Provider attempt">
                  <Pill tone={PROVIDER_STATUS_TONE[detailData.latestProviderAttempt.status]}>
                    {PROVIDER_ATTEMPT_STATUS_LABELS[detailData.latestProviderAttempt.status]}
                  </Pill>
                </DetailRow>
                <DetailRow label="MantaPay transaction ID">{detailData.latestProviderAttempt.transactionId ?? '—'}</DetailRow>
                <DetailRow label="MantaPay reply">
                  {[detailData.latestProviderAttempt.replyCode, detailData.latestProviderAttempt.replyDescription].filter(Boolean).join(' · ') || '—'}
                </DetailRow>
                <DetailRow label="Provider attempt time"><DateCell ts={detailData.latestProviderAttempt.occurredAt} /></DetailRow>
              </>
            )}
            <div className="field">
              <label htmlFor="detail-note">Internal note</label>
              <textarea id="detail-note" value={detailNote} readOnly={!canCreate} onChange={(e) => setDetailNote(e.target.value)} />
              {canCreate && <button className="btn ghost small" onClick={saveNote} disabled={isSavingNote}>{isSavingNote ? 'Saving…' : 'Save note'}</button>}
            </div>
            {detailQuery.data && (
              <div className="field">
                <div className="field-label">Timeline</div>
                <div className="timeline">
                  {detailQuery.data.events.map((event, index) => (
                    <div className="timeline-row" key={`${event.type}-${event.occurredAt}-${index}`}>
                      <span>{EVENT_LABELS[event.type]}</span>
                      <DateCell ts={event.occurredAt} />
                    </div>
                  ))}
                </div>
                <p className="sub">This shows activity visible to HigherPays. Internal actions inside CentroBill are not available.</p>
              </div>
            )}
            {isShareable(detailData.status) && detailData.checkoutUrl && (
              <div className="field">
                <label htmlFor="detail-url">Checkout URL</label>
                <div className="field-row">
                  <input id="detail-url" type="text" readOnly value={detailData.checkoutUrl} onFocus={(e) => e.target.select()} />
                  <CopyButton value={detailData.checkoutUrl} />
                </div>
              </div>
            )}
            {detailData.status === 'pending' && (
              <div className="callout">
                <p className="sub">The customer has paid. The payment needs its details — who paid and what for — before it counts as revenue.</p>
              </div>
            )}
            <div className="modal-actions">
              {detailData.status === 'pending' && canComplete && (
                <Link className="btn" to={`/payments?needs_details=1&q=${encodeURIComponent(detailData.referenceId)}`}>Complete on Payments</Link>
              )}
              {isShareable(detailData.status) && canCreate && (
                <button className="btn danger" onClick={() => setCancelling(detailData)}>Cancel link</button>
              )}
              {canCreate && (detailData.archivedAt
                ? <button className="btn ghost" onClick={() => changeArchived(detailData, false)}>Restore link</button>
                : <button className="btn ghost" onClick={() => changeArchived(detailData, true)}>Archive link</button>)}
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
            ? `Closes on the first payment, or after ${expiryHours} ${expiryHours === 1 ? 'hour' : 'hours'} if nobody pays.`
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
        <div className="field">
          <label htmlFor="link-note">Internal note</label>
          <textarea id="link-note" value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Visible only inside HigherPays" />
        </div>

        <div className={`pl-fees${fees && fees.effectivePct >= 18 ? ' hot' : fees && fees.effectivePct >= 15 ? ' warm' : ''}`}>
          <div className="fee-line">
            <span>Customer pays</span>
            <b className="fee-val">{fees ? formatMoney(fees.customerTotal) : '—'}</b>
          </div>
          <div className="fee-line">
            <span>MDR ({rateCard.pspRate}% of {fees ? formatMoney(fees.customerTotal) : '—'})</span>
            <b className="fee-val">{fees ? formatMoney(fees.mdrFee) : '—'}</b>
          </div>
          <div className="fee-line">
            <span>Transaction fee</span>
            <b className="fee-val">{fees ? formatMoney(fees.fixed) : '—'}</b>
          </div>
          <div className="fee-line">
            <span>Settlement fee ({rateCard.settlementRate}% of {fees ? formatMoney(fees.settlementBase) : '—'})</span>
            <b className="fee-val">{fees ? formatMoney(fees.settlementFee) : '—'}</b>
          </div>
          {rateCard.marginRate > 0 && (
            <div className="fee-line">
              <span>HigherPays margin ({rateCard.marginRate}% of {fees ? formatMoney(fees.amount) : '—'})</span>
              <b className="fee-val">{fees ? formatMoney(fees.marginFee) : '—'}</b>
            </div>
          )}
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
