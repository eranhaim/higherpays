import { useMemo, useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { useRateCard } from '../../hooks/useRateCard';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import {
  PageHeader, StatCard, StatGrid, Money, Pill, DateCell,
  DataTable, FilterBar, DateRangePicker, DetailRow,
  type Column, type DateRange,
} from '../../components/ui';
import { formatMoney, sum } from '../../lib/format';
import { isReversed, TRANSACTION_STATUS_LABELS, type Transaction } from '../../api/endpoints';
import { usePaymentsData } from './usePaymentsData';
import { filterTransactions, DEFAULT_FILTERS, type PaymentsFilters } from './filters';

const STATUS_TONE: Record<Transaction['status'], 'ok' | 'no' | 'muted'> = {
  approved: 'ok',
  declined: 'no',
  refunded: 'no',
  charged_back: 'no',
};

function StatusPill({ status }: { status: Transaction['status'] }) {
  return <Pill tone={STATUS_TONE[status]}>{TRANSACTION_STATUS_LABELS[status]}</Pill>;
}

export default function PaymentsPage() {
  const can = useCan();
  const { transactions, isLoading, isError, recordRefund } = usePaymentsData();
  const { rateCard } = useRateCard();

  const [filters, setFilters] = useState<PaymentsFilters>(DEFAULT_FILTERS);
  const [detail, setDetail] = useState<Transaction | null>(null);
  const [refunding, setRefunding] = useState<Transaction | null>(null);
  const [refundConfirmed, setRefundConfirmed] = useState(false);
  const [isRecordingRefund, setIsRecordingRefund] = useState(false);

  const filtered = useMemo(() => filterTransactions(transactions, filters), [transactions, filters]);
  const paid = useMemo(() => filtered.filter((t) => t.status === 'approved'), [filtered]);
  const declined = filtered.filter((t) => t.status === 'declined');
  const reversed = filtered.filter((t) => isReversed(t.status));
  const gross = sum(paid.map((t) => t.gross));
  const fees = sum(paid.map((t) => t.platformFee));
  const attempts = paid.length + declined.length;

  const range: DateRange = { from: filters.from, to: filters.to };
  const setRange = (r: DateRange) => setFilters((f) => ({ ...f, ...r }));

  const columns: Column<Transaction>[] = [
    { key: 'reference', header: 'Reference', render: (t) => <span className="ref">{t.providerTransactionId ?? '—'}</span> },
    { key: 'customer', header: 'Customer', render: (t) => <span className="cname">{t.customer ?? '—'}</span> },
    { key: 'creator', header: 'Creator', render: (t) => t.creator ?? '—' },
    { key: 'chatter', header: 'Chatter', render: (t) => t.chatter ?? '—' },
    {
      key: 'gross', header: 'Gross', align: 'right',
      render: (t) => <Money amount={t.gross} direction={isReversed(t.status) ? 'out' : undefined} />,
    },
    { key: 'fee', header: 'Fee', align: 'right', render: (t) => <span className="fee">{formatMoney(t.platformFee)}</span> },
    { key: 'status', header: 'Status', render: (t) => <StatusPill status={t.status} /> },
    { key: 'date', header: 'Date', render: (t) => <DateCell ts={t.occurredAt} /> },
  ];

  const closeRefund = () => { setRefunding(null); setRefundConfirmed(false); };

  const submitRefund = async (t: Transaction) => {
    if (!refundConfirmed) { toast('Confirm you issued the refund in MantaPay first.'); return; }
    setIsRecordingRefund(true);
    try {
      await recordRefund(t.id);
      closeRefund();
      setDetail(null);
      toast(`Recorded refund of ${formatMoney(t.gross)}.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not record the refund.');
    } finally {
      setIsRecordingRefund(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Money in"
        title="Payments"
        subtitle="Every payment attempt, with the fees taken on each."
      />

      <StatGrid>
        <StatCard label="Gross" value={<Money amount={gross} direction="in" />} sub="Paid in view" />
        <StatCard label="Platform fees" value={<Money amount={fees} direction="out" />} sub={`${rateCard.blended.toFixed(1)}% blended`} />
        <StatCard label="Net" value={<Money amount={gross - fees} direction="in" emphasis />} sub="After platform fees" />
        <StatCard
          label="Approval rate"
          value={`${attempts ? Math.round((paid.length / attempts) * 100) : 0}%`}
          sub={`${paid.length} of ${attempts} attempts`}
        />
        <StatCard
          label="Reversed"
          value={<Money amount={sum(reversed.map((t) => t.gross))} direction="out" />}
          sub={`${reversed.length} refunds and chargebacks`}
        />
      </StatGrid>

      <FilterBar>
        <select
          value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as PaymentsFilters['status'] }))}
        >
          <option value="">All statuses</option>
          {(Object.keys(TRANSACTION_STATUS_LABELS) as Transaction['status'][]).map((s) => (
            <option key={s} value={s}>{TRANSACTION_STATUS_LABELS[s]}</option>
          ))}
        </select>
        <DateRangePicker value={range} onChange={setRange} />
        <input
          type="search"
          className="search-input"
          placeholder="Search reference, customer, creator, chatter"
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
        />
        <button className="btn ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>Clear</button>
      </FilterBar>

      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(t) => t.id}
        onRowClick={setDetail}
        isLoading={isLoading}
        emptyTitle={isError ? "Couldn't load payments." : 'No payments match these filters.'}
        emptyHint={isError ? 'Try again in a moment.' : 'Widen the date range or clear the filters.'}
        footer={`Showing ${filtered.length} of ${transactions.length}`}
      />

      <Modal open={!!detail && !refunding} onClose={() => setDetail(null)}>
        {detail && (
          <>
            <h3>Payment</h3>
            <div className="modal-topline">
              <span className="ref">{detail.providerTransactionId ?? detail.id}</span>
              <StatusPill status={detail.status} />
            </div>
            <DetailRow label="Customer">{detail.customer ?? '—'}</DetailRow>
            <DetailRow label="Creator">{detail.creator ?? '—'}</DetailRow>
            <DetailRow label="Chatter">{detail.chatter ?? '—'}</DetailRow>
            <DetailRow label="Gross"><Money amount={detail.gross} direction="in" /></DetailRow>
            <DetailRow label="Platform fee"><Money amount={detail.platformFee} direction="out" /></DetailRow>
            <DetailRow label="Net"><Money amount={detail.gross - detail.platformFee} direction="in" emphasis /></DetailRow>
            <DetailRow label="Date"><DateCell ts={detail.occurredAt} /></DetailRow>
            {isReversed(detail.status) && (
              <div className="warnbar">This sale has been reversed in the ledger.</div>
            )}
            <div className="modal-actions">
              {detail.status === 'approved' && can('commissions.manage') && (
                <button className="btn danger" onClick={() => setRefunding(detail)}>Record refund</button>
              )}
              <span className="spacer" />
              <button className="btn" onClick={() => setDetail(null)}>Close</button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={!!refunding} onClose={closeRefund}>
        {refunding && (
          <>
            <h3>Record a refund</h3>
            <p className="sub">
              Issue the refund in MantaPay first. Recording it here reverses the sale in your ledger so payouts stay correct.
            </p>
            <div className="callout">
              <DetailRow label="Refund to customer"><Money amount={refunding.gross} direction="out" /></DetailRow>
              <DetailRow label="Refund fee"><Money amount={rateCard.refundFee} direction="out" /></DetailRow>
              <p className="sub">Platform fees already taken ({formatMoney(refunding.platformFee)}) are not returned by the provider.</p>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={refundConfirmed}
                onChange={(e) => setRefundConfirmed(e.target.checked)}
              />
              <span>I have issued this refund in MantaPay.</span>
            </label>
            <div className="modal-actions">
              <button className="btn ghost" onClick={closeRefund}>Cancel</button>
              <button className="btn danger" onClick={() => submitRefund(refunding)} disabled={isRecordingRefund}>
                {isRecordingRefund ? 'Recording…' : `Record refund of ${formatMoney(refunding.gross)}`}
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
