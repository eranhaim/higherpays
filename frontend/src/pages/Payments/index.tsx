import { useMemo, useState } from 'react';
import { useDebounced } from '../../hooks/useDebounced';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useRateCard } from '../../hooks/useRateCard';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import {
  PageHeader, StatCard, StatGrid, Money, Pill, DateCell,
  DataTable, FilterBar, DateRangePicker, DetailRow,
  type Column, type DateRange,
} from '../../components/ui';
import { formatMoney, sum } from '../../lib/format';
import {
  isReversed, PAYMENT_STATUSES, PAYMENT_STATUS_LABELS,
  type Payment, type PaymentStatus, type ListPaymentsQuery,
} from '../../api/endpoints';
import { usePaymentsData } from './usePaymentsData';

const STATUS_TONE: Record<PaymentStatus, 'ok' | 'no' | 'warn' | 'muted'> = {
  pending: 'muted',
  paid: 'ok',
  failed: 'no',
  cancelled: 'muted',
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

export default function PaymentsPage() {
  const can = useCan();
  const { labels } = useCurrentSession();
  const { rateCard } = useRateCard();
  const canScope = can('data.view_all');
  const canComplete = can('payments.complete');
  const canRefund = can('revenue.manage');

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const search = useDebounced(filters.search, 300);
  const query = useMemo<ListPaymentsQuery>(() => ({
    status: filters.status || undefined,
    accountId: filters.accountId || undefined,
    agentId: filters.agentId || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
    q: search.trim() || undefined,
    needsDetails: filters.needsDetails || undefined,
  }), [filters.status, filters.accountId, filters.agentId, filters.from, filters.to, filters.needsDetails, search]);

  const {
    payments, categories, customers, accounts, agents,
    isLoading, isError, hasMore, isLoadingMore, loadMore, complete, recordRefund,
  } = usePaymentsData(query, canScope);

  const [detail, setDetail] = useState<Payment | null>(null);
  const [completing, setCompleting] = useState<Payment | null>(null);
  const [refunding, setRefunding] = useState<Payment | null>(null);
  const [refundConfirmed, setRefundConfirmed] = useState(false);
  const [isRecordingRefund, setIsRecordingRefund] = useState(false);

  const paid = payments.filter((p) => p.status === 'paid');
  const failed = payments.filter((p) => p.status === 'failed');
  const reversed = payments.filter((p) => isReversed(p.status));
  const gross = sum(paid.map((p) => p.amount));
  const fees = sum(paid.map((p) => p.platformFee ?? 0));
  const attempts = paid.length + failed.length;
  const awaiting = payments.filter((p) => p.needsDetails).length;
  const statsUnknown = isLoading || isError;

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
    { key: 'account', header: labels.account, render: (p) => p.account },
    { key: 'agent', header: labels.agent, render: (p) => p.agent ?? '—' },
    { key: 'category', header: 'Category', render: (p) => p.category ?? '—' },
    {
      key: 'amount', header: 'Amount', align: 'right',
      render: (p) => <Money amount={p.amount} currency={p.currency} direction={isReversed(p.status) ? 'out' : p.status === 'paid' ? 'in' : undefined} />,
    },
    ...(canScope ? [{
      key: 'fee', header: 'Fee', align: 'right' as const,
      render: (p: Payment) => p.platformFee == null ? '—' : <Money amount={p.platformFee} direction="out" />,
    }] : []),
    { key: 'status', header: 'Status', render: (p) => <StatusPill payment={p} /> },
    { key: 'date', header: 'Date', render: (p) => <DateCell ts={p.occurredAt} /> },
  ];

  const closeRefund = () => { setRefunding(null); setRefundConfirmed(false); };

  const submitRefund = async (p: Payment) => {
    if (!refundConfirmed) { toast('Confirm you issued the refund in MantaPay first.'); return; }
    setIsRecordingRefund(true);
    try {
      await recordRefund(p.id);
      closeRefund();
      setDetail(null);
      toast(`Recorded refund of ${formatMoney(p.amount, p.currency)}.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not record the refund.');
    } finally {
      setIsRecordingRefund(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Payments"
        subtitle={canScope ? 'Every payment attempt, with the fees taken on each.' : 'Payments credited to you.'}
      />

      {isError && (
        <div className="warnbar" role="alert">
          Couldn't load payments. The figures below are incomplete — reload to try again.
        </div>
      )}

      <StatGrid>
        <StatCard isUnknown={statsUnknown} label="Gross" value={<Money amount={gross} direction="in" />} sub="Paid, loaded" />
        {canScope && (
          <StatCard isUnknown={statsUnknown} label="Platform fees" value={<Money amount={fees} direction="out" />} sub={`${rateCard.blended.toFixed(1)}% blended`} />
        )}
        <StatCard
          isUnknown={statsUnknown}
          label="Approval rate"
          value={`${attempts ? Math.round((paid.length / attempts) * 100) : 0}%`}
          sub={`${paid.length} of ${attempts} attempts`}
        />
        <StatCard isUnknown={statsUnknown} label="Details needed" value={awaiting} sub="Paid, not yet completed" />
        <StatCard
          isUnknown={statsUnknown}
          label="Reversed"
          value={<Money amount={sum(reversed.map((p) => p.amount))} direction="out" />}
          sub={`${reversed.length} refunds`}
        />
      </StatGrid>

      <FilterBar>
        <select
          aria-label="Filter by status"
          value={filters.needsDetails ? 'needs_details' : filters.status}
          onChange={(e) => {
            const v = e.target.value;
            setFilters((f) => ({ ...f, needsDetails: v === 'needs_details', status: v === 'needs_details' ? '' : v as Filters['status'] }));
          }}
        >
          <option value="">All statuses</option>
          <option value="needs_details">Details needed</option>
          {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{PAYMENT_STATUS_LABELS[s]}</option>)}
        </select>
        {canScope && (
          <>
            <select aria-label={`Filter by ${labels.account}`} value={filters.accountId} onChange={(e) => setFilters((f) => ({ ...f, accountId: e.target.value }))}>
              <option value="">All {labels.accounts.toLowerCase()}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select aria-label={`Filter by ${labels.agent}`} value={filters.agentId} onChange={(e) => setFilters((f) => ({ ...f, agentId: e.target.value }))}>
              <option value="">All {labels.agents.toLowerCase()}</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </>
        )}
        <DateRangePicker value={range} onChange={setRange} />
        <input
          type="search"
          className="search-input"
          aria-label="Search payments"
          placeholder="Search reference, customer, account, agent"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
        />
        <button className="btn ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear</button>
      </FilterBar>

      <DataTable
        columns={columns}
        rows={payments}
        rowKey={(p) => p.id}
        onRowClick={setDetail}
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

      <Modal open={!!detail && !refunding && !completing} onClose={() => setDetail(null)} title="Payment">
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
              {detail.status === 'paid' && canRefund && (
                <button className="btn danger" onClick={() => setRefunding(detail)}>Record refund</button>
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

      <Modal
        open={!!refunding}
        onClose={closeRefund}
        title="Record a refund"
        subtitle="Issue the refund in MantaPay first. Recording it here reverses the sale in your ledger so payouts stay correct."
      >
        {refunding && (
          <>
            <div className="callout">
              <DetailRow label="Refund to customer"><Money amount={refunding.amount} currency={refunding.currency} direction="out" /></DetailRow>
              {rateCard.refundFee !== undefined && (
                <DetailRow label="Refund fee"><Money amount={rateCard.refundFee} direction="out" /></DetailRow>
              )}
              {refunding.platformFee != null && (
                <p className="sub">Platform fees already taken ({formatMoney(refunding.platformFee)}) are not returned by the provider.</p>
              )}
            </div>
            <label className="check-row">
              <input type="checkbox" checked={refundConfirmed} onChange={(e) => setRefundConfirmed(e.target.checked)} />
              <span>I have issued this refund in MantaPay.</span>
            </label>
            <div className="modal-actions">
              <button className="btn ghost" onClick={closeRefund}>Cancel</button>
              <button className="btn danger" onClick={() => submitRefund(refunding)} disabled={isRecordingRefund}>
                {isRecordingRefund ? 'Recording…' : `Record refund of ${formatMoney(refunding.amount, refunding.currency)}`}
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
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
      <div className="field">
        <label htmlFor="complete-customer">Customer</label>
        <select id="complete-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">New customer…</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.telegramName ? ` · ${c.telegramName}` : ''}</option>)}
        </select>
      </div>
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
      <div className="field">
        <label htmlFor="complete-category">Category</label>
        <select id="complete-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          {categories.length === 0 && <option value="">No categories defined — ask an admin</option>}
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={submit} disabled={isSaving || !categoryId}>{isSaving ? 'Saving…' : 'Save details'}</button>
      </div>
    </Modal>
  );
}
