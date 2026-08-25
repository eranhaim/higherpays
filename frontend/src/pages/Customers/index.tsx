import { useMemo, useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import {
  PageHeader, Money, DateCell, DataTable, FilterBar, DetailRow, type Column,
} from '../../components/ui';
import {
  CUSTOMER_SEGMENTS, CUSTOMER_SEGMENT_LABELS,
  type Customer, type CustomerSegment,
} from '../../api/endpoints';
import { useCustomersData } from './useCustomersData';

type SortKey = 'spend' | 'recent';

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
  const {
    customers, accounts, isLoading, isError, hasMore, isLoadingMore, loadMore, createCustomer, exportCsv,
  } = useCustomersData();
  const accountNameById = useMemo(() => new Map(accounts.map((c) => [c.id, c.stageName])), [accounts]);

  const [segment, setSegment] = useState<'' | CustomerSegment>('');
  const [accountId, setAccountId] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('spend');
  const [detail, setDetail] = useState<Customer | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [alias, setAlias] = useState('');
  const [email, setEmail] = useState('');
  const [newAccountId, setNewAccountId] = useState('');
  const [newSegment, setNewSegment] = useState<CustomerSegment>('new');
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = customers.filter((c) => {
      if (segment && c.segment !== segment) return false;
      if (accountId && c.accountId !== accountId) return false;
      if (q && !`${c.alias} ${c.email ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const key = (c: Customer) => sort === 'spend' ? c.totalSpend : (c.lastPurchaseAt ? Date.parse(c.lastPurchaseAt) : 0);
    return rows.sort((a, b) => key(b) - key(a));
  }, [customers, segment, accountId, search, sort]);

  const clearFilters = () => { setSegment(''); setAccountId(''); setSearch(''); setSort('spend'); };

  const closeAdd = () => {
    setAddOpen(false);
    setAlias(''); setEmail(''); setNewAccountId(''); setNewSegment('new');
  };

  const submitAdd = async () => {
    if (!alias.trim()) { toast('Name is required.'); return; }
    setIsSaving(true);
    try {
      await createCustomer({
        alias: alias.trim(),
        email: email.trim() || undefined,
        accountId: newAccountId || undefined,
        segment: newSegment,
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
          <div className="cname" title={c.alias}>{c.alias}</div>
          {c.email && <div className="cemail" title={c.email}>{c.email}</div>}
        </>
      ),
    },
    { key: 'account', header: 'Account', render: (c) => (c.accountId && accountNameById.get(c.accountId)) ?? '—' },
    { key: 'spend', header: 'Total spend', align: 'right', render: (c) => <Money amount={c.totalSpend} direction="in" /> },
    { key: 'last', header: 'Last purchase', render: (c) => <DateCell ts={c.lastPurchaseAt} /> },
    { key: 'segment', header: 'Segment', render: (c) => <SegmentTag segment={c.segment} /> },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="People"
        title="Customers"
        subtitle="Everyone who paid, what they spent, and which account they belong to."
        actions={
          <>
            {can('customers.export') && (
              <button className="btn ghost" onClick={runExport} disabled={isExporting}>
                {isExporting ? 'Exporting…' : 'Export CSV'}
              </button>
            )}
            {can('customers.manage') && <button className="btn" onClick={() => setAddOpen(true)}>Add customer</button>}
          </>
        }
      />

      <FilterBar>
        <select
          aria-label="Filter by segment"
          value={segment}
          onChange={(e) => setSegment(e.target.value as '' | CustomerSegment)}
        >
          <option value="">All segments</option>
          {CUSTOMER_SEGMENTS.map((s) => <option key={s} value={s}>{CUSTOMER_SEGMENT_LABELS[s]}</option>)}
        </select>
        <select aria-label="Filter by account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map((c) => <option key={c.id} value={c.id}>{c.stageName}</option>)}
        </select>
        <select aria-label="Sort customers" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="spend">Highest spend first</option>
          <option value="recent">Most recent first</option>
        </select>
        <input
          type="search" className="search-input" aria-label="Search customers"
          placeholder="Search name or email" value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn ghost" onClick={clearFilters}>Clear</button>
      </FilterBar>

      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(c) => c.id}
        onRowClick={setDetail}
        isLoading={isLoading}
        emptyTitle={isError ? "Couldn't load customers." : 'No customers match these filters.'}
        emptyHint={isError ? 'Try again in a moment.' : 'Customers appear here once a link is paid, or add one by hand.'}
        footer={
          <span className="table-foot-row">
            Showing {filtered.length} of {customers.length} loaded
            {hasMore && (
              <button className="btn ghost small" onClick={loadMore} disabled={isLoadingMore}>
                {isLoadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </span>
        }
      />

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.alias ?? ''}
        subtitle={detail?.email ?? 'No email on record'}
      >
        {detail && (
          <>
            <DetailRow label="Account">{(detail.accountId && accountNameById.get(detail.accountId)) ?? '—'}</DetailRow>
            <DetailRow label="Segment"><SegmentTag segment={detail.segment} /></DetailRow>
            <DetailRow label="Total spend"><Money amount={detail.totalSpend} direction="in" emphasis /></DetailRow>
            <DetailRow label="Last purchase"><DateCell ts={detail.lastPurchaseAt} /></DetailRow>
            <DetailRow label="Customer since"><DateCell ts={detail.createdAt} /></DetailRow>
            <div className="modal-actions">
              <button className="btn" onClick={() => setDetail(null)}>Close</button>
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={addOpen}
        onClose={closeAdd}
        title="Add customer"
        subtitle="Keep only data you have a lawful basis to hold."
      >
        <div className="field">
          <label htmlFor="customer-alias">Name or username</label>
          <input id="customer-alias" type="text" value={alias} onChange={(e) => setAlias(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="customer-email">Email</label>
          <input id="customer-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="customer-account">Account</label>
          <select id="customer-account" value={newAccountId} onChange={(e) => setNewAccountId(e.target.value)}>
            <option value="">Not assigned</option>
            {accounts.map((c) => <option key={c.id} value={c.id}>{c.stageName}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="customer-segment">Segment</label>
          <select id="customer-segment" value={newSegment} onChange={(e) => setNewSegment(e.target.value as CustomerSegment)}>
            {CUSTOMER_SEGMENTS.map((s) => <option key={s} value={s}>{CUSTOMER_SEGMENT_LABELS[s]}</option>)}
          </select>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={closeAdd}>Cancel</button>
          <button className="btn" onClick={submitAdd} disabled={isSaving}>{isSaving ? 'Adding…' : 'Add customer'}</button>
        </div>
      </Modal>
    </div>
  );
}
