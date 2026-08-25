import { useState, useMemo } from 'react';
import { useAppStore } from '../../store/appStore';
import Modal from '../../components/Modal';
import { toast } from '../../components/Toast';
import { tzParts } from '../../business/timezone';
import { PageHeader } from '../../components/ui';
import type { Customer, CustomerSegment } from '../../types';
import { useCustomersData } from './useCustomersData';

const fmt = (n: number) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(n); }
  catch { return 'EUR ' + n.toFixed(2); }
};

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const segClass = (s: string) =>
  s === 'VIP' ? 'seg vip' : s === 'At-risk' ? 'seg risk' : s === 'Inactive' ? 'seg inactive' : 'seg';

const custAvg = (c: Customer) => c.purchases ? c.spend / c.purchases : 0;

interface ColDef { k: string; label: string }

const CUST_COLS: ColDef[] = [
  { k: 'name', label: 'Customer' }, { k: 'username', label: 'Username' },
  { k: 'creator', label: 'Creator' }, { k: 'chatter', label: 'Chatter' },
  { k: 'spend', label: 'Total spend' }, { k: 'ltv', label: 'LTV' },
  { k: 'purchases', label: '# Buys' }, { k: 'avg', label: 'Avg / sale' },
  { k: 'last', label: 'Last purchase' }, { k: 'seg', label: 'Segment' },
];

const DEFAULT_COLS = new Set(['name', 'username', 'creator', 'chatter', 'spend', 'avg', 'last', 'seg']);
const SEGMENTS: CustomerSegment[] = ['New', 'Regular', 'High value', 'VIP', 'Inactive', 'At-risk'];

export default function CustomersPage() {
  const { customers, isLoading, isError } = useCustomersData();
  const creators = useAppStore(s => s.creators);
  const chatters = useAppStore(s => s.chatters);
  const links = useAppStore(s => s.links);
  const tzMode = useAppStore(s => s.tzMode);
  const tzManual = useAppStore(s => s.tzManual);

  const activeTZ = () => {
    if (tzMode === 'manual' && tzManual) return tzManual;
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  };

  const fmtDate = (ts: number) => {
    const p = tzParts(ts, activeTZ());
    const hh = String(p.h).padStart(2, '0'), mm = String(p.mi).padStart(2, '0');
    return { date: `${p.d} ${MON[p.mo - 1]} ${p.y}`, time: `${hh}:${mm}` };
  };

  // Filters
  const [seg, setSeg] = useState('');
  const [search, setSearch] = useState('');
  const [crFilter, setCrFilter] = useState('');
  const [chFilter, setChFilter] = useState('');
  const [sort, setSort] = useState('spend');

  // Column chooser
  const [cols, setCols] = useState(DEFAULT_COLS);
  const [colModal, setColModal] = useState(false);
  const [colPick, setColPick] = useState(DEFAULT_COLS);

  // Customer card
  const [cardId, setCardId] = useState<string | null>(null);

  // Filtered list
  const filtered = useMemo(() => {
    let list = customers.filter(c => {
      if (seg && c.seg !== seg) return false;
      if (crFilter && c.creator !== crFilter) return false;
      if (chFilter && c.chatter !== chFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!(c.name + c.username + (c.email || '')).toLowerCase().includes(q)) return false;
      }
      return true;
    });
    const keyFn: Record<string, (c: Customer) => number> = {
      spend: c => c.spend, ltv: c => c.spend, avg: custAvg, last: c => c.last,
    };
    const fn = keyFn[sort] || (c => c.spend);
    return [...list].sort((a, b) => fn(b) - fn(a));
  }, [customers, seg, crFilter, chFilter, search, sort]);

  const visibleCols = CUST_COLS.filter(c => cols.has(c.k));

  const cellContent = (c: Customer, k: string) => {
    switch (k) {
      case 'name': return <span className="cname">{c.name}</span>;
      case 'username': return <span className="cemail">{c.username}</span>;
      case 'spend': case 'ltv': return <span className="amt">{fmt(c.spend)}</span>;
      case 'avg': return fmt(custAvg(c));
      case 'purchases': return c.purchases;
      case 'last': { const d = fmtDate(c.last); return <span className="time">{d.date}<br /><span style={{ color: '#4d5a72' }}>{d.time}</span></span>; }
      case 'seg': return <span className={segClass(c.seg)}>{c.seg}</span>;
      default: return (c as unknown as Record<string, string>)[k] || '';
    }
  };

  const clearFilters = () => { setSeg(''); setSearch(''); setCrFilter(''); setChFilter(''); setSort('spend'); };

  const applyColumns = () => {
    if (colPick.size === 0) { toast('Pick at least one column.'); return; }
    setCols(new Set(colPick));
    setColModal(false);
  };

  // Customer card data
  const cardCustomer = cardId ? customers.find(c => c.id === cardId) : null;
  const cardLinks = cardCustomer ? links.filter(l => l.customerUsername === cardCustomer.username) : [];

  return (
    <div>
      <PageHeader
        eyebrow="People"
        title="Customers"
        subtitle="Everyone who paid, with what they spent and who they belong to."
      />

      {/* Filters */}
      <div className="filters">
        <select value={seg} onChange={e => setSeg(e.target.value)}>
          <option value="">All segments</option>
          {SEGMENTS.map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={crFilter} onChange={e => setCrFilter(e.target.value)}>
          <option value="">All creators</option>
          {[...new Set(creators.map(c => c.name))].map(n => <option key={n}>{n}</option>)}
        </select>
        <select value={chFilter} onChange={e => setChFilter(e.target.value)}>
          <option value="">All chatters</option>
          {[...new Set(chatters.map(c => c.name))].map(n => <option key={n}>{n}</option>)}
        </select>
        <select value={sort} onChange={e => setSort(e.target.value)}>
          <option value="spend">Sort by spend</option>
          <option value="avg">Sort by avg</option>
          <option value="last">Sort by recent</option>
        </select>
        <input type="text" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 200 }} />
        <button className="btn ghost" onClick={clearFilters}>Clear</button>
        <button className="btn ghost" onClick={() => { setColPick(new Set(cols)); setColModal(true); }}>Columns</button>
      </div>

      {/* Table */}
      <div className="card">
        <div className="tablewrap">
          <table>
            <thead>
              <tr>{visibleCols.map(c => <th key={c.k}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={visibleCols.length} style={{ padding: 36, textAlign: 'center', color: 'var(--muted)' }}>
                    Loading customers…
                  </td>
                </tr>
              ) : isError ? (
                <tr>
                  <td colSpan={visibleCols.length} style={{ padding: 36, textAlign: 'center', color: 'var(--neg)' }}>
                    Couldn't load customers. Try again in a moment.
                  </td>
                </tr>
              ) : filtered.length > 0 ? filtered.map(c => (
                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setCardId(c.id)}>
                  {visibleCols.map(col => <td key={col.k}>{cellContent(c, col.k)}</td>)}
                </tr>
              )) : (
                <tr>
                  <td colSpan={visibleCols.length} style={{ padding: 36, textAlign: 'center', color: 'var(--muted)' }}>
                    No customers match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '8px 12px', fontSize: '13.2px', color: 'var(--muted)' }}>Showing {filtered.length}</div>
      </div>

      {/* Customer card modal */}
      <Modal open={!!cardCustomer} onClose={() => setCardId(null)}>
        {cardCustomer && (
          <>
            <h3>{cardCustomer.username}</h3>
            <p className="sub">{cardCustomer.name} &middot; {cardCustomer.email || 'no email'}</p>
            <div className="deep">
              <div className="dcell"><div className="dl">Total spend / LTV</div><div className="dv">{fmt(cardCustomer.spend)}</div></div>
              <div className="dcell"><div className="dl">Purchases</div><div className="dv">{cardCustomer.purchases}</div></div>
              <div className="dcell"><div className="dl">Avg / sale</div><div className="dv">{fmt(custAvg(cardCustomer))}</div></div>
              <div className="dcell"><div className="dl">Segment</div><div className="dv" style={{ fontSize: '15.4px' }}><span className={segClass(cardCustomer.seg)}>{cardCustomer.seg}</span></div></div>
            </div>
            <div className="setrow"><div className="k">Creator</div><span className="mono-val">{cardCustomer.creator}</span></div>
            <div className="setrow"><div className="k">Chatter</div><span className="mono-val">{cardCustomer.chatter}</span></div>
            <div className="setrow"><div className="k">Last purchase</div><span className="mono-val">{new Date(cardCustomer.last).toLocaleString()}</span></div>
            <div className="sechead">Recent links ({cardLinks.length})</div>
            <div style={{ maxHeight: 120, overflow: 'auto', fontSize: '14.3px' }}>
              {cardLinks.slice(0, 6).map(l => (
                <div className="ws-row" key={l.id}>
                  <span>{l.creator} &middot; {fmt(l.amount)}</span>
                  <span className={`pill ${l.status === 'Paid' ? 'ok' : 'no'}`}>{l.status}</span>
                </div>
              ))}
              {cardLinks.length === 0 && <span style={{ color: 'var(--muted)' }}>No links.</span>}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setCardId(null)}>Close</button>
            </div>
          </>
        )}
      </Modal>

      {/* Column chooser modal */}
      <Modal open={colModal} onClose={() => setColModal(false)}>
        <h3>Choose columns</h3>
        <p className="sub">Pick what shows in the customers table.</p>
        <div style={{ maxHeight: 260, overflow: 'auto' }}>
          {CUST_COLS.map(c => (
            <label key={c.k} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 0', fontSize: '15.4px' }}>
              <input type="checkbox" checked={colPick.has(c.k)}
                onChange={e => {
                  setColPick(prev => {
                    const next = new Set(prev);
                    e.target.checked ? next.add(c.k) : next.delete(c.k);
                    return next;
                  });
                }}
                style={{ minWidth: 'auto', width: 'auto' }} />
              {c.label}
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setColModal(false)}>Cancel</button>
          <button className="btn" onClick={applyColumns}>Apply</button>
        </div>
      </Modal>

    </div>
  );
}
