import { useMemo, useState } from 'react';
import { useDebounced } from '../../hooks/useDebounced';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import {
  PageHeader, Money, DateCell, DataTable, FilterBar, DetailRow, Pill, type Column,
} from '../../components/ui';
import {
  CUSTOMER_SEGMENTS, CUSTOMER_SEGMENT_LABELS, PAYMENT_STATUS_LABELS,
  type Customer, type CustomerSegment,
} from '../../api/endpoints';
import { useCustomersData, useCustomerDetail } from './useCustomersData';

const SEGMENT_CLASS: Record<CustomerSegment, string> = {
  new: 'seg',
  regular: 'seg',
  high_value: 'seg',
  vip: 'seg vip',
  inactive: 'seg inactive',
  at_risk: 'seg risk',
};

function SegmentTag({ segment }: { segment: CustomerSegment }) {
  return <span className={SEGMENT_CLASS[segment]}>{CUSTOMER_SEGMENT_LABELS[segment]}</span>;
}

export default function CustomersPage() {
  const can = useCan();
  const { labels } = useCurrentSession();
  const [segment, setSegment] = useState<'' | CustomerSegment>('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const query = useMemo(() => ({ segment: segment || undefined, q: q.trim() || undefined }), [segment, q]);

  const { customers, isLoading, isError, hasMore, isLoadingMore, loadMore, createCustomer, exportCsv } = useCustomersData(query);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = useCustomerDetail(detailId);

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [telegramName, setTelegramName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const closeAdd = () => { setAddOpen(false); setName(''); setTelegramName(''); setEmail(''); setPhone(''); };

  const submitAdd = async () => {
    if (!name.trim()) { toast('Name is required.'); return; }
    setIsSaving(true);
    try {
      await createCustomer({
        name: name.trim(),
        telegramName: telegramName.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      closeAdd();
      toast('Customer added.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the customer.');
    } finally {
      setIsSaving(false);
    }
  };

  const runExport = async () => {
    setIsExporting(true);
    try {
      await exportCsv();
      toast('Customers exported to CSV.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setIsExporting(false);
    }
  };

  const columns: Column<Customer>[] = [
    {
      key: 'customer', header: 'Customer',
      render: (c) => (
        <>
          <div className="cname" title={c.name}>{c.name}</div>
          {(c.telegramName || c.email) && <div className="cemail">{c.telegramName ?? c.email}</div>}
        </>
      ),
    },
    { key: 'spend', header: 'Total spend', align: 'right', render: (c) => <Money amount={c.totalSpend} direction="in" /> },
    { key: 'last', header: 'Last purchase', render: (c) => <DateCell ts={c.lastPurchaseAt} /> },
    { key: 'segment', header: 'Segment', render: (c) => <SegmentTag segment={c.segment} /> },
  ];

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle="Everyone who paid, and what they spent. A customer meets an account through a payment link, not by assignment."
        actions={
          <>
            {can('customers.export') && (
              <button className="btn ghost" onClick={runExport} disabled={isExporting}>{isExporting ? 'Exporting…' : 'Export CSV'}</button>
            )}
            {can('customers.manage') && <button className="btn" onClick={() => setAddOpen(true)}>Add customer</button>}
          </>
        }
      />

      <FilterBar>
        <select aria-label="Filter by segment" value={segment} onChange={(e) => setSegment(e.target.value as '' | CustomerSegment)}>
          <option value="">All segments</option>
          {CUSTOMER_SEGMENTS.map((s) => <option key={s} value={s}>{CUSTOMER_SEGMENT_LABELS[s]}</option>)}
        </select>
        <input type="search" className="search-input" aria-label="Search customers"
          placeholder="Search name, Telegram, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn ghost" onClick={() => { setSegment(''); setSearch(''); }}>Clear</button>
      </FilterBar>

      <DataTable
        columns={columns}
        rows={customers}
        rowKey={(c) => c.id}
        onRowClick={(c) => setDetailId(c.id)}
        isLoading={isLoading}
        emptyTitle={isError ? "Couldn't load customers." : 'No customers match.'}
        emptyHint={isError ? 'Try again in a moment.' : 'Customers appear here once a payment is completed, or add one by hand.'}
        footer={
          <span className="table-foot-row">
            {customers.length} loaded
            {hasMore && (
              <button className="btn ghost small" onClick={loadMore} disabled={isLoadingMore}>{isLoadingMore ? 'Loading…' : 'Load more'}</button>
            )}
          </span>
        }
      />

      <Modal open={detailId !== null} onClose={() => setDetailId(null)}
        title={detail.data?.name ?? 'Customer'} subtitle={detail.data?.telegramName ?? detail.data?.email ?? undefined}>
        {detail.isLoading && <p className="sub">Loading…</p>}
        {detail.isError && <p className="sub">Couldn't load this customer.</p>}
        {detail.data && (
          <>
            <DetailRow label="Email">{detail.data.email ?? '—'}</DetailRow>
            <DetailRow label="Phone">{detail.data.phone ?? '—'}</DetailRow>
            <DetailRow label="Segment"><SegmentTag segment={detail.data.segment} /></DetailRow>
            <DetailRow label="Total spend"><Money amount={detail.data.totalSpend} direction="in" emphasis /></DetailRow>
            <DetailRow label="Customer since"><DateCell ts={detail.data.createdAt} /></DetailRow>
            <div className="sechead">Payments</div>
            {detail.data.payments.length === 0 ? <p className="sub">No payments yet.</p> : (
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">{labels.account}</th>
                      <th scope="col">{labels.agent}</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.payments.map((p) => (
                      <tr key={p.id}>
                        <td><DateCell ts={p.occurredAt} /></td>
                        <td>{p.account}</td>
                        <td>{p.agent ?? '—'}</td>
                        <td><Money amount={p.amount} currency={p.currency} direction={p.status === 'paid' ? 'in' : undefined} /></td>
                        <td><Pill tone={p.status === 'paid' ? 'ok' : p.status === 'failed' || p.status === 'refunded' ? 'no' : 'muted'}>{PAYMENT_STATUS_LABELS[p.status]}</Pill></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => setDetailId(null)}>Close</button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={addOpen} onClose={closeAdd} title="Add customer" subtitle="Keep only data you have a lawful basis to hold.">
        <div className="field">
          <label htmlFor="customer-name">Name</label>
          <input id="customer-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="customer-telegram">Telegram name</label>
          <input id="customer-telegram" type="text" placeholder="@name" value={telegramName} onChange={(e) => setTelegramName(e.target.value)} />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="customer-email">Email</label>
            <input id="customer-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="customer-phone">Phone</label>
            <input id="customer-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={closeAdd}>Cancel</button>
          <button className="btn" onClick={submitAdd} disabled={isSaving}>{isSaving ? 'Adding…' : 'Add customer'}</button>
        </div>
      </Modal>
    </div>
  );
}
