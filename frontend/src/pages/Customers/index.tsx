import { useMemo, useState } from 'react';
import { useDebounced } from '../../hooks/useDebounced';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import {
  PageHeader, Money, DateCell, DataTable, FilterBar, DetailRow, Pill, Select, ViewPicker,
  type Column, type SortState,
} from '../../components/ui';
import { useViewLayout, orderBy } from '../../hooks/useViewLayout';
import {
  CUSTOMER_SEGMENTS, CUSTOMER_SEGMENT_LABELS, PAYMENT_STATUS_LABELS,
  type Customer, type CustomerSegment, type CustomerSort, type CreateCustomerInput, type UpdateCustomerInput,
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
  const canManage = can('customers.manage');
  const [segment, setSegment] = useState<'' | CustomerSegment>('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const [sort, setSort] = useState<SortState>({ key: 'last', dir: 'desc' });
  // A fresh column starts at its most useful end: latest, largest, first name.
  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  const query = useMemo(() => ({
    segment: segment || undefined,
    q: q.trim() || undefined,
    sort: sort.key as CustomerSort,
    dir: sort.dir,
  }), [segment, q, sort]);

  const {
    customers, isLoading, isError, hasMore, isLoadingMore, loadMore,
    createCustomer, updateCustomer, eraseCustomer, exportCsv,
  } = useCustomersData(query);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = useCustomerDetail(detailId);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [erasing, setErasing] = useState<Customer | null>(null);
  const [isErasing, setIsErasing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const runExport = async () => {
    setIsExporting(true);
    try { await exportCsv(); toast('Customers exported to CSV.'); }
    catch (err) { toast(err instanceof Error ? err.message : 'Export failed.'); }
    finally { setIsExporting(false); }
  };

  const confirmErase = async (c: Customer) => {
    setIsErasing(true);
    try {
      await eraseCustomer(c.id);
      setErasing(null);
      setDetailId(null);
      toast(`${c.name} erased. Their payments stay, anonymised.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not erase the customer.');
    } finally {
      setIsErasing(false);
    }
  };

  const columns: Column<Customer>[] = [
    {
      key: 'customer', header: 'Customer', sortKey: 'name',
      render: (c) => (
        <>
          <div className="cname" title={c.name}>{c.name}</div>
          {(c.telegramName || c.email) && <div className="cemail">{c.telegramName ?? c.email}</div>}
        </>
      ),
    },
    { key: 'spend', header: 'Total spend', sortKey: 'spend', render: (c) => <Money amount={c.totalSpend} direction="in" /> },
    { key: 'last', header: 'Last purchase', sortKey: 'last', render: (c) => <DateCell ts={c.lastPurchaseAt} /> },
    {
      key: 'segment', header: 'Segment', sortKey: 'segment', render: (c) => <SegmentTag segment={c.segment} />,
      isFiltered: segment !== '',
      filter: (
        <Select label="Segment" hideLabel value={segment} onChange={(v) => setSegment(v as '' | CustomerSegment)}>
          <option value="">All segments</option>
          {CUSTOMER_SEGMENTS.map((s) => <option key={s} value={s}>{CUSTOMER_SEGMENT_LABELS[s]}</option>)}
        </Select>
      ),
    },
  ];

  const columnsView = useViewLayout('customers.columns', columns.map((c) => ({ key: c.key, label: c.header })));
  const shownColumns: Column<Customer>[] = [
    ...orderBy(columns, columnsView.visibleKeys),
    // The actions cell is a control, not data: it is never hidden or moved.
    ...(canManage ? [{
      key: 'actions', header: 'Actions', hideHeader: true, align: 'right' as const,
      render: (c: Customer) => (
        <div className="cell-actions">
          <button className="btn ghost small" onClick={() => setEditing(c)}>Edit</button>
        </div>
      ),
    }] : []),
  ];

  return (
    <div>
      <PageHeader
        title="Customers"
        actions={
          <>
            {can('customers.export') && (
              <button className="btn ghost" onClick={runExport} disabled={isExporting}>{isExporting ? 'Exporting…' : 'Export CSV'}</button>
            )}
            {canManage && <button className="btn" onClick={() => setAddOpen(true)}>Add customer</button>}
          </>
        }
      />

      <FilterBar>
        <input type="search" className="search-input" aria-label="Search customers"
          placeholder="Search name, Telegram, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn ghost" onClick={() => { setSegment(''); setSearch(''); }}>Clear</button>
        <ViewPicker label="Edit columns" view={columnsView} />
      </FilterBar>

      <DataTable
        columns={shownColumns}
        rows={customers}
        rowKey={(c) => c.id}
        onRowClick={(c) => setDetailId(c.id)}
        sort={sort}
        onSort={toggleSort}
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

      <Modal open={detailId !== null && editing === null && erasing === null} onClose={() => setDetailId(null)}
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
                        <td><Pill tone={p.status === 'paid' ? 'ok' : 'no'}>{PAYMENT_STATUS_LABELS[p.status]}</Pill></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="modal-actions">
              {canManage && (
                <>
                  <button className="btn ghost" onClick={() => setEditing(detail.data)}>Edit</button>
                  <button className="btn ghost" onClick={() => setErasing(detail.data)}>Erase</button>
                </>
              )}
              <span className="spacer" />
              <button className="btn ghost" onClick={() => setDetailId(null)}>Close</button>
            </div>
          </>
        )}
      </Modal>

      {addOpen && (
        <CustomerFormModal
          title="Add customer"
          subtitle="Keep only data you have a lawful basis to hold."
          onClose={() => setAddOpen(false)}
          onSubmit={async (values) => {
            await createCustomer(values);
            setAddOpen(false);
            toast('Customer added.');
          }}
        />
      )}

      {editing && (
        <CustomerFormModal
          title={`Edit ${editing.name}`}
          customer={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            await updateCustomer(editing.id, values);
            setEditing(null);
            toast('Customer updated.');
          }}
        />
      )}

      <Modal open={erasing !== null} onClose={() => setErasing(null)} title={erasing ? `Erase ${erasing.name}?` : ''}
        subtitle="Their name and contact details are wiped for good. Their payments stay in the ledger, anonymised. Use this for an erasure request.">
        {erasing && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setErasing(null)}>Keep</button>
            <button className="btn danger" disabled={isErasing} onClick={() => confirmErase(erasing)}>{isErasing ? 'Erasing…' : 'Erase customer'}</button>
          </div>
        )}
      </Modal>
    </div>
  );
}

interface CustomerFormValues {
  name: string;
  telegramName?: string;
  email?: string;
  phone?: string;
  segment?: CustomerSegment;
}

/** Add and edit are the same form; edit also lets the segment be set by hand. */
function CustomerFormModal({ title, subtitle, customer, onClose, onSubmit }: {
  title: string;
  subtitle?: string;
  customer?: Customer;
  onClose: () => void;
  onSubmit: (values: CreateCustomerInput & UpdateCustomerInput) => Promise<void>;
}) {
  const [name, setName] = useState(customer?.name ?? '');
  const [telegramName, setTelegramName] = useState(customer?.telegramName ?? '');
  const [email, setEmail] = useState(customer?.email ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [segment, setSegment] = useState<CustomerSegment>(customer?.segment ?? 'new');
  const [isSaving, setIsSaving] = useState(false);
  const editing = Boolean(customer);

  const submit = async () => {
    if (!name.trim()) { toast('Name is required.'); return; }
    setIsSaving(true);
    try {
      const values: CustomerFormValues = {
        name: name.trim(),
        // Editing sends the cleared field so the server blanks it; adding just omits it.
        telegramName: telegramName.trim() || (editing ? '' : undefined),
        email: email.trim() || (editing ? '' : undefined),
        phone: phone.trim() || (editing ? '' : undefined),
        ...(editing ? { segment } : {}),
      };
      await onSubmit(values);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the customer.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={title} subtitle={subtitle}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
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
        {editing && (
          <Select id="customer-segment" label="Segment" value={segment} onChange={(v) => setSegment(v as CustomerSegment)}
            hint="Segments are recomputed from spend; setting one by hand holds until the next purchase.">
            {CUSTOMER_SEGMENTS.map((s) => <option key={s} value={s}>{CUSTOMER_SEGMENT_LABELS[s]}</option>)}
          </Select>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={isSaving}>{isSaving ? 'Saving…' : editing ? 'Save changes' : 'Add customer'}</button>
        </div>
      </form>
    </Modal>
  );
}
