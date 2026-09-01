import { Fragment, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDebounced } from '../../hooks/useDebounced';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useRateCard } from '../../hooks/useRateCard';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import {
  PageHeader, StatCard, StatGrid, Money, Pill, DateCell,
  DataTable, FilterBar, Calendar, DateRangePicker, DetailRow, Select, ViewPicker,
  type Column, type DateRange, type SortState,
} from '../../components/ui';
import { useViewLayout, orderBy } from '../../hooks/useViewLayout';
import { formatMoney, sum } from '../../lib/format';
import {
  isReversed, PAYMENT_STATUSES, PAYMENT_STATUS_LABELS, PAYMENT_EXPORT_COLUMNS,
  type Payment, type PaymentStatus, type PaymentSort, type ListPaymentsQuery,
} from '../../api/endpoints';
import { usePaymentsData, type ExportInput } from './usePaymentsData';

const STATUS_TONE: Record<PaymentStatus, 'ok' | 'no' | 'warn'> = {
  paid: 'ok',
  failed: 'no',
  refunded: 'no',
};

function StatusPill({ payment }: { payment: Payment }) {
  if (payment.needsDetails) return <Pill tone="warn">Details needed</Pill>;
  return <Pill tone={STATUS_TONE[payment.status]}>{PAYMENT_STATUS_LABELS[payment.status]}</Pill>;
}

interface Filters {
  status: '' | PaymentStatus;
  accountId: string;
  agentId: string;
  from: string;
  to: string;
  search: string;
  needsDetails: boolean;
}

const DEFAULT_FILTERS: Filters = { status: '', accountId: '', agentId: '', from: '', to: '', search: '', needsDetails: false };

type ReversalKind = 'refund' | 'chargeback';

export default function PaymentsPage() {
  const can = useCan();
  const { labels } = useCurrentSession();
  const { rateCard } = useRateCard();
  const canScope = can('data.view_all');
  const canComplete = can('payments.complete');
  const canReverse = can('revenue.manage');
  const canExport = can('payments.export');

  // Another page can point here at one payment ("complete the details for
  // this link"), so the search and the details-needed filter come from the URL.
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => ({
    ...DEFAULT_FILTERS,
    search: params.get('q') ?? '',
    needsDetails: params.get('needs_details') === '1',
  }));
  const [sort, setSort] = useState<SortState>({ key: 'date', dir: 'desc' });
  // A fresh column starts at its most useful end: newest, largest, first status.
  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  const search = useDebounced(filters.search, 300);
  const query = useMemo<ListPaymentsQuery>(() => ({
    status: filters.status || undefined,
    accountId: filters.accountId || undefined,
    agentId: filters.agentId || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    q: search.trim() || undefined,
    needsDetails: filters.needsDetails || undefined,
    sort: sort.key as PaymentSort,
    dir: sort.dir,
  }), [filters.status, filters.accountId, filters.agentId, filters.from, filters.to, filters.needsDetails, search, sort]);

  const {
    payments, categories, customers, accounts, agents,
    isLoading, isError, hasMore, isLoadingMore, loadMore, complete, recordReversal, exportCsv,
  } = usePaymentsData(query, canScope);

  const [detail, setDetail] = useState<Payment | null>(null);
  const [completing, setCompleting] = useState<Payment | null>(null);
  const [reversing, setReversing] = useState<{ payment: Payment; kind: ReversalKind } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const paid = payments.filter((p) => p.status === 'paid');
  const failed = payments.filter((p) => p.status === 'failed');
  const reversed = payments.filter((p) => isReversed(p.status));
  const gross = sum(paid.map((p) => p.amount));
  const fees = sum(paid.map((p) => p.platformFee ?? 0));
  const attempts = paid.length + failed.length;
  const awaiting = payments.filter((p) => p.needsDetails).length;
  const statsUnknown = isLoading || isError;

  const statCards = [
    {
      key: 'gross', label: 'Gross',
      card: <StatCard isUnknown={statsUnknown} label="Gross" value={<Money amount={gross} direction="in" />} sub="Gross revenue, before fees" />,
    },
    ...(canScope ? [{
      key: 'fees', label: 'Platform fees',
      card: <StatCard isUnknown={statsUnknown} label="Platform fees" value={<Money amount={fees} direction="out" />} sub={`${rateCard.blended.toFixed(1)}%`} />,
    }] : []),
    {
      key: 'approvalRate', label: 'Approval rate',
      card: (
        <StatCard
          isUnknown={statsUnknown}
          label="Approval rate"
          value={`${attempts ? Math.round((paid.length / attempts) * 100) : 0}%`}
          sub={`${paid.length} of ${attempts} attempts`}
        />
      ),
    },
    {
      key: 'detailsNeeded', label: 'Details needed',
      card: <StatCard isUnknown={statsUnknown} label="Details needed" value={awaiting} sub="Paid, not yet completed" />,
    },
    {
      key: 'refunded', label: 'Refunded',
      card: (
        <StatCard
          isUnknown={statsUnknown}
          label="Refunded"
          value={<Money amount={sum(reversed.map((p) => p.amount))} direction="out" />}
          sub={`${reversed.length} refunds`}
        />
      ),
    },
  ];
  // Useful figures, but not what this page is read for — off unless asked for.
  const statsView = useViewLayout('payments.stats', statCards, ['approvalRate', 'detailsNeeded']);

  const range: DateRange = { from: filters.from, to: filters.to };
  const setRange = (r: DateRange) => setFilters((f) => ({ ...f, ...r }));

  const columns: Column<Payment>[] = [
    {
      key: 'reference', header: 'Reference',
      render: (p) => <span className="ref" title={p.providerTransactionId ?? undefined}>{p.providerTransactionId ?? p.linkReference ?? '—'}</span>,
    },
    {
      key: 'customer', header: 'Customer',
      render: (p) => <span className="cname" title={p.customer ?? undefined}>{p.customer ?? '—'}</span>,
    },
    {
      key: 'account', header: labels.account, render: (p) => p.account,
      isFiltered: filters.accountId !== '',
      filter: canScope ? (
        <Select label={labels.account} hideLabel value={filters.accountId} onChange={(v) => setFilters((f) => ({ ...f, accountId: v }))}>
          <option value="">All {labels.accounts.toLowerCase()}</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      ) : undefined,
    },
    {
      key: 'agent', header: labels.agent, render: (p) => p.agent ?? '—',
      isFiltered: filters.agentId !== '',
      filter: canScope ? (
        <Select label={labels.agent} hideLabel value={filters.agentId} onChange={(v) => setFilters((f) => ({ ...f, agentId: v }))}>
          <option value="">All {labels.agents.toLowerCase()}</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      ) : undefined,
    },
    { key: 'category', header: 'Category', render: (p) => p.category ?? '—' },
    {
      key: 'amount', header: 'Amount', sortKey: 'amount',
      render: (p) => <Money amount={p.amount} currency={p.currency} direction={isReversed(p.status) ? 'out' : p.status === 'paid' ? 'in' : undefined} />,
    },
    ...(canScope ? [{
      key: 'fee', header: 'Fee',
      render: (p: Payment) => p.platformFee == null ? '—' : <Money amount={p.platformFee} direction="out" />,
    }] : []),
    {
      key: 'status', header: 'Status', sortKey: 'status', render: (p) => <StatusPill payment={p} />,
      isFiltered: filters.status !== '' || filters.needsDetails,
      filter: (
        <Select
          label="Status" hideLabel
          value={filters.needsDetails ? 'needs_details' : filters.status}
          onChange={(v) => setFilters((f) => ({ ...f, needsDetails: v === 'needs_details', status: v === 'needs_details' ? '' : v as Filters['status'] }))}
        >
          <option value="">All statuses</option>
          <option value="needs_details">Details needed</option>
          {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{PAYMENT_STATUS_LABELS[s]}</option>)}
        </Select>
      ),
    },
    {
      key: 'date', header: 'Date', sortKey: 'date', render: (p) => <DateCell ts={p.occurredAt} />,
      isFiltered: filters.from !== '' || filters.to !== '',
      filter: <Calendar value={range} onChange={setRange} />,
    },
  ];

  const columnsView = useViewLayout('payments.columns', columns.map((c) => ({ key: c.key, label: c.header })));
  const shownColumns: Column<Payment>[] = [
    ...orderBy(columns, columnsView.visibleKeys),
    // The actions cell is a control, not data: it is never hidden or moved.
    ...(canComplete ? [{
      key: 'actions', header: 'Actions', hideHeader: true, align: 'right' as const,
      // "Details needed" is a job, not a status: the row carries the way to do it
      // rather than hiding it behind opening the payment.
      render: (p: Payment) => p.needsDetails
        ? <button className="btn ghost small" onClick={() => setCompleting(p)}>Complete</button>
        : null,
    }] : []),
  ];

  return (
    <div>
      <PageHeader
        title="Payments"
        actions={
          <>
            <ViewPicker label="Edit cards" view={statsView} />
            {canExport && <button className="btn ghost" onClick={() => setExportOpen(true)}>Export CSV</button>}
          </>
        }
      />

      {isError && (
        <div className="warnbar" role="alert">
          Couldn't load payments. The figures below are incomplete — reload to try again.
        </div>
      )}

      <StatGrid>
        {orderBy(statCards, statsView.visibleKeys).map((c) => <Fragment key={c.key}>{c.card}</Fragment>)}
      </StatGrid>

      <FilterBar>
        <input
          type="search"
          className="search-input"
          aria-label="Search payments"
          placeholder="Search reference, customer, account, agent"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
        />
        <button className="btn ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear</button>
        <ViewPicker label="Edit columns" view={columnsView} />
      </FilterBar>

      <DataTable
        columns={shownColumns}
        rows={payments}
        rowKey={(p) => p.id}
        onRowClick={setDetail}
        sort={sort}
        onSort={toggleSort}
        isLoading={isLoading}
        emptyTitle={isError ? "Couldn't load payments." : 'No payments match these filters.'}
        emptyHint={isError ? 'Try again in a moment.' : 'Widen the date range or clear the filters.'}
        footer={
          <span className="table-foot-row">
            {payments.length} loaded
            {hasMore && (
              <button className="btn ghost small" onClick={loadMore} disabled={isLoadingMore}>
                {isLoadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </span>
        }
      />

      <Modal open={!!detail && !reversing && !completing} onClose={() => setDetail(null)} title="Payment">
        {detail && (
          <>
            <div className="modal-topline">
              <span className="ref">{detail.providerTransactionId ?? detail.id}</span>
              <StatusPill payment={detail} />
            </div>
            <DetailRow label="Customer">{detail.customer ?? '—'}{detail.customerTelegram ? <span className="sub inline"> · {detail.customerTelegram}</span> : null}</DetailRow>
            <DetailRow label="Category">{detail.category ?? '—'}</DetailRow>
            <DetailRow label={labels.account}>{detail.account}</DetailRow>
            <DetailRow label={labels.agent}>{detail.agent ?? '—'}</DetailRow>
            <DetailRow label="Link">{detail.linkReference ?? '—'}</DetailRow>
            <DetailRow label="Amount"><Money amount={detail.amount} currency={detail.currency} direction="in" /></DetailRow>
            {detail.platformFee != null && (
              <>
                <DetailRow label="Platform fee"><Money amount={detail.platformFee} direction="out" /></DetailRow>
                <DetailRow label="Net"><Money amount={detail.amount - detail.platformFee} direction="in" emphasis /></DetailRow>
              </>
            )}
            <DetailRow label="Date"><DateCell ts={detail.occurredAt} /></DetailRow>
            {isReversed(detail.status) && <div className="warnbar">This sale has been reversed in the ledger.</div>}
            <div className="modal-actions">
              {detail.needsDetails && canComplete && (
                <button className="btn" onClick={() => setCompleting(detail)}>Complete details</button>
              )}
              {detail.status === 'paid' && canReverse && (
                <>
                  <button className="btn danger" onClick={() => setReversing({ payment: detail, kind: 'refund' })}>Record refund</button>
                  <button className="btn ghost" onClick={() => setReversing({ payment: detail, kind: 'chargeback' })}>Record chargeback</button>
                </>
              )}
              <span className="spacer" />
              <button className="btn ghost" onClick={() => setDetail(null)}>Close</button>
            </div>
          </>
        )}
      </Modal>

      {completing && (
        <CompleteDetailsModal
          payment={completing}
          categories={categories}
          customers={customers}
          onClose={() => setCompleting(null)}
          onSubmit={async (input) => {
            await complete(completing.id, input);
            setCompleting(null);
            setDetail(null);
            toast('Payment details saved.');
          }}
        />
      )}

      {exportOpen && (
        <ExportModal
          range={range}
          loadedCount={payments.length}
          canSeeFees={canScope}
          onClose={() => setExportOpen(false)}
          onSubmit={async (input) => {
            await exportCsv(input);
            setExportOpen(false);
            toast('Payments exported to CSV.');
          }}
        />
      )}

      {reversing && (
        <ReversalModal
          payment={reversing.payment}
          kind={reversing.kind}
          fee={reversing.kind === 'refund' ? rateCard.refundFee : rateCard.chargebackFee}
          onClose={() => setReversing(null)}
          onSubmit={async () => {
            await recordReversal(reversing.payment.id, reversing.kind);
            setReversing(null);
            setDetail(null);
            toast(`Recorded ${reversing.kind} of ${formatMoney(reversing.payment.amount, reversing.payment.currency)}.`);
          }}
        />
      )}
    </div>
  );
}

/** What goes in the file: the period, how many rows, and which columns. */
function ExportModal({ range, loadedCount, canSeeFees, onClose, onSubmit }: {
  range: DateRange;
  loadedCount: number;
  canSeeFees: boolean;
  onClose: () => void;
  onSubmit: (input: ExportInput) => Promise<void>;
}) {
  const columns = PAYMENT_EXPORT_COLUMNS.filter((c) => !c.feesOnly || canSeeFees);
  const [dates, setDates] = useState<DateRange>(range);
  const [scope, setScope] = useState<'all' | 'loaded'>('all');
  const [selected, setSelected] = useState<string[]>(columns.map((c) => c.key));
  const [isExporting, setIsExporting] = useState(false);

  const submit = async () => {
    if (selected.length === 0) { toast('Pick at least one column.'); return; }
    setIsExporting(true);
    try { await onSubmit({ from: dates.from, to: dates.to, columns: selected, limit: scope === 'loaded' ? loadedCount : undefined }); }
    catch (err) { toast(err instanceof Error ? err.message : 'Export failed.'); }
    finally { setIsExporting(false); }
  };

  return (
    <Modal open onClose={onClose} title="Export payments"
      subtitle="The filters on the page still apply; the period below overrides the one in the filter bar.">
      <div className="field">
        <div className="field-label">Date range</div>
        <DateRangePicker value={dates} onChange={setDates} />
      </div>
      <div className="field" role="radiogroup" aria-labelledby="export-rows-label">
        <div className="field-label" id="export-rows-label">Rows</div>
        <label className="check-row">
          <input type="radio" name="export-rows" checked={scope === 'all'} onChange={() => setScope('all')} />
          <span>All matching</span>
        </label>
        <label className="check-row">
          <input type="radio" name="export-rows" checked={scope === 'loaded'} onChange={() => setScope('loaded')} />
          <span>Only the {loadedCount} rows loaded on the page</span>
        </label>
      </div>
      <div className="field" role="group" aria-labelledby="export-columns-label">
        <div className="field-label" id="export-columns-label">Columns</div>
        <div className="check-list">
          {columns.map((c) => (
            <label key={c.key} className="check-row">
              <input
                type="checkbox"
                checked={selected.includes(c.key)}
                onChange={(e) => setSelected((prev) => e.target.checked ? [...prev, c.key] : prev.filter((k) => k !== c.key))}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={submit} disabled={isExporting}>{isExporting ? 'Exporting…' : 'Export CSV'}</button>
      </div>
    </Modal>
  );
}

const REVERSAL_COPY: Record<ReversalKind, { title: string; subtitle: string; confirm: string; feeLabel: string }> = {
  refund: {
    title: 'Record a refund',
    subtitle: 'Issue the refund in MantaPay first. Recording it here reverses the sale in your ledger so payouts stay correct.',
    confirm: 'I have issued this refund in MantaPay.',
    feeLabel: 'Refund fee',
  },
  chargeback: {
    title: 'Record a chargeback',
    subtitle: "MantaPay has taken the money back from you. Recording it here reverses the sale and charges the chargeback fee to whoever bears it.",
    confirm: 'MantaPay has reported this chargeback.',
    feeLabel: 'Chargeback fee',
  },
};

/** A refund or a chargeback: the same reversal, with a different fee and wording. */
function ReversalModal({ payment, kind, fee, onClose, onSubmit }: {
  payment: Payment;
  kind: ReversalKind;
  fee: number | undefined;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const copy = REVERSAL_COPY[kind];
  const [confirmed, setConfirmed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const submit = async () => {
    if (!confirmed) { toast('Tick the confirmation first.'); return; }
    setIsSaving(true);
    try { await onSubmit(); }
    catch (err) { toast(err instanceof Error ? err.message : `Could not record the ${kind}.`); }
    finally { setIsSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={copy.title} subtitle={copy.subtitle}>
      <div className="callout">
        <DetailRow label="Reversed"><Money amount={payment.amount} currency={payment.currency} direction="out" /></DetailRow>
        {fee !== undefined && <DetailRow label={copy.feeLabel}><Money amount={fee} direction="out" /></DetailRow>}
        {payment.platformFee != null && (
          <p className="sub">Platform fees already taken ({formatMoney(payment.platformFee)}) are not returned by the provider.</p>
        )}
      </div>
      <label className="check-row">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>{copy.confirm}</span>
      </label>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn danger" onClick={submit} disabled={isSaving}>
          {isSaving ? 'Recording…' : `Record ${kind} of ${formatMoney(payment.amount, payment.currency)}`}
        </button>
      </div>
    </Modal>
  );
}

interface CompleteDetailsModalProps {
  payment: Payment;
  categories: { id: string; name: string }[];
  customers: { id: string; name: string; telegramName: string | null }[];
  onClose: () => void;
  onSubmit: (input: { categoryId: string; customerId?: string; customer?: { name: string; telegramName?: string } }) => Promise<void>;
}

/** The agent says who paid and what for. An existing customer or a new one. */
function CompleteDetailsModal({ payment, categories, customers, onClose, onSubmit }: CompleteDetailsModalProps) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [customerId, setCustomerId] = useState(payment.customerId ?? '');
  const [name, setName] = useState('');
  const [telegramName, setTelegramName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const typingNew = customerId === '';

  const submit = async () => {
    if (!categoryId) { toast('Pick a category.'); return; }
    if (typingNew && !name.trim()) { toast('Enter the customer name.'); return; }
    setIsSaving(true);
    try {
      await onSubmit({
        categoryId,
        ...(typingNew
          ? { customer: { name: name.trim(), ...(telegramName.trim() ? { telegramName: telegramName.trim() } : {}) } }
          : { customerId }),
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the details.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Complete payment details" subtitle={`${formatMoney(payment.amount, payment.currency)} · ${payment.account}`}>
      <Select id="complete-customer" label="Customer" value={customerId} onChange={setCustomerId}>
        <option value="">New customer…</option>
        {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.telegramName ? ` · ${c.telegramName}` : ''}</option>)}
      </Select>
      {typingNew && (
        <div className="form-row">
          <div className="field">
            <label htmlFor="complete-name">Customer name</label>
            <input id="complete-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="complete-telegram">Telegram name</label>
            <input id="complete-telegram" type="text" placeholder="@name" value={telegramName} onChange={(e) => setTelegramName(e.target.value)} />
          </div>
        </div>
      )}
      <Select id="complete-category" label="Category" value={categoryId} onChange={setCategoryId}
        hint={categories.length === 0 ? 'No categories defined yet — an admin adds them under Settings.' : undefined}>
        {categories.length === 0 && <option value="">No categories defined</option>}
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={submit} disabled={isSaving || !categoryId}>{isSaving ? 'Saving…' : 'Save details'}</button>
      </div>
    </Modal>
  );
}
