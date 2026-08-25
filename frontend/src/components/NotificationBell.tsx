import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../store/appStore';
import { useCan } from '../hooks/usePermission';
import Modal from './Modal';
import { toast } from './Toast';
import type { Notification, Permission } from '../types';

const fmt = (n: number, cur = 'EUR') => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n); }
  catch { return cur + ' ' + n.toFixed(2); }
};

function timeAgo(t: number): string {
  const m = Math.round((Date.now() - t) / 6e4);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.round(m / 60) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
}

const N_ICON: Record<string, string> = {
  'payment.paid': '✅',
  'payment.failed': '⚠️',
  'payment.refunded': '↩️',
  'payment.chargeback': '❌',
  'payout.paid': '💸',
};

const N_EVENTS: [string, string][] = [
  ['payment.paid', 'Payment received'],
  ['payment.failed', 'Payment declined'],
  ['payment.refunded', 'Refund issued'],
  ['payment.chargeback', 'Chargeback'],
  ['payout.paid', 'Payout sent'],
];

const N_EVENT_PERM: Record<string, Permission> = {
  'payment.paid': 'payments.view',
  'payment.failed': 'payments.view',
  'payment.refunded': 'payments.view',
  'payment.chargeback': 'commissions.view',
  'payout.paid': 'commissions.view',
};

const N_EVENT_DESC: Record<string, string> = {
  'payment.paid': 'Every successful payment.',
  'payment.failed': 'Declined or failed attempts.',
  'payment.refunded': 'When a transaction is refunded.',
  'payment.chargeback': 'When a customer disputes a payment.',
  'payout.paid': 'When a creator or chatter is paid.',
};

export default function NotificationBell() {
  const can = useCan();
  const transactions = useAppStore(s => s.transactions);
  const [open, setOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [notifPrefs, setNotifPrefs] = useState<string[] | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const allowedEvents = N_EVENTS.filter(([k]) => can(N_EVENT_PERM[k])).map(([k]) => k);
  const subscribedEvents = notifPrefs ? allowedEvents.filter(e => notifPrefs.includes(e)) : allowedEvents;

  // Generate demo notifications
  const demoNotifs = useCallback((): Notification[] => {
    if (!subscribedEvents.includes('payment.paid')) return [];
    const paid = transactions.filter(t => t.status === 'approved').slice(0, 6);
    return paid.map((t, i) => ({
      id: 'n' + i,
      event: 'payment.paid',
      title: 'Payment received',
      body: 'Creator: ' + (t.creator || '–'),
      amount: t.amount,
      currency: t.currency || 'EUR',
      read: i > 1,
      createdAt: new Date(t.ts).toISOString(),
      entityType: 'transaction',
      entityId: t.id,
    }));
  }, [transactions, subscribedEvents]);

  const [notifs, setNotifs] = useState<Notification[]>(() => demoNotifs());
  const unread = notifs.filter(n => !n.read).length;

  // Refresh notifs when deps change
  useEffect(() => {
    setNotifs(demoNotifs());
  }, [demoNotifs]);

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const markAllRead = () => {
    setNotifs(prev => prev.map(n => ({ ...n, read: true })));
  };

  // Prefs
  const [prefsPick, setPrefsPick] = useState<Set<string>>(new Set(subscribedEvents));

  const openPrefs = () => {
    setPrefsPick(new Set(subscribedEvents));
    setOpen(false);
    setPrefsOpen(true);
  };

  const savePrefs = () => {
    const chosen = [...prefsPick];
    setNotifPrefs(chosen);
    toast('Notification preferences saved.');
    setPrefsOpen(false);
  };

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(!open)}
        title="Notifications"
        style={{
          position: 'relative', background: 'none', border: 'none',
          color: 'var(--muted)', cursor: 'pointer', padding: 6,
          borderRadius: 9, transition: 'color .15s, background .15s',
        }}
        onMouseEnter={e => { (e.target as HTMLElement).style.color = 'var(--brand)'; (e.target as HTMLElement).style.background = 'var(--panel-2)'; }}
        onMouseLeave={e => { (e.target as HTMLElement).style.color = 'var(--muted)'; (e.target as HTMLElement).style.background = 'none'; }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} style={{ width: 20, height: 20 }}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16,
            padding: '0 4px', borderRadius: 9, background: 'var(--red)',
            color: '#fff', fontSize: '10.5px', fontWeight: 800,
            lineHeight: '16px', textAlign: 'center',
          }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {/* Notification panel */}
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 38, width: 300, maxHeight: 340,
          overflow: 'auto', background: 'var(--panel-2)', border: '1px solid var(--line)',
          borderRadius: 13, boxShadow: '0 20px 50px rgba(0,0,0,.5)', zIndex: 800,
          padding: 6,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, padding: '6px 10px 8px' }}>
            <span style={{ fontWeight: 800, fontSize: '13.4px' }}>Notifications</span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {unread > 0 && (
                <button className="btn ghost" style={{ padding: '3px 9px', fontWeight: 400, fontSize: '12px' }} onClick={markAllRead}>
                  Mark all read
                </button>
              )}
              <button className="btn ghost" title="Choose what you get notified about" style={{ padding: '3px 8px', fontWeight: 400, fontSize: '13px' }} onClick={openPrefs}>
                ⚙
              </button>
            </span>
          </div>
          {notifs.length > 0 ? notifs.map(n => (
            <div key={n.id} style={{
              display: 'flex', gap: 10, padding: '10px 10px',
              borderTop: '1px solid rgba(30,43,68,.4)',
              background: n.read ? 'transparent' : 'rgba(21,195,175,.06)',
              cursor: n.entityType === 'transaction' ? 'pointer' : undefined,
              borderRadius: 6,
            }}
            onClick={() => {
              if (!n.read) {
                setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
              }
            }}
            >
              <span style={{ fontSize: '16px' }}>{N_ICON[n.event] || '🔔'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '13.2px' }}>
                  {n.title}{n.amount != null ? ' · ' + fmt(n.amount, n.currency) : ''}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: 2 }}>
                  {n.body ? n.body + ' · ' : ''}{timeAgo(new Date(n.createdAt).getTime())}
                </div>
              </div>
            </div>
          )) : (
            <div style={{ padding: 22, textAlign: 'center', color: 'var(--muted)', fontSize: '13px' }}>
              Nothing yet.
            </div>
          )}
        </div>
      )}

      {/* Notification preferences modal */}
      <Modal open={prefsOpen} onClose={() => setPrefsOpen(false)}>
        <h3>Your notifications</h3>
        <p className="sub">Choose what appears in your notification bell. This is personal — it doesn't change what your teammates see.</p>
        <div>
          {allowedEvents.length > 0 ? allowedEvents.map(k => {
            const label = (N_EVENTS.find(x => x[0] === k) || [, k])[1];
            return (
              <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 0', borderBottom: '1px solid rgba(30,43,68,.5)', cursor: 'pointer' }}>
                <input type="checkbox" checked={prefsPick.has(k)}
                  onChange={e => {
                    setPrefsPick(prev => {
                      const next = new Set(prev);
                      e.target.checked ? next.add(k) : next.delete(k);
                      return next;
                    });
                  }}
                  style={{ minWidth: 'auto', width: 'auto', marginTop: 3, cursor: 'pointer' }} />
                <span>
                  <span style={{ fontWeight: 700, fontSize: '14px' }}>{N_ICON[k] || ''} {label}</span>
                  <span style={{ display: 'block', color: 'var(--muted)', fontSize: '12.6px' }}>{N_EVENT_DESC[k] || ''}</span>
                </span>
              </label>
            );
          }) : (
            <p className="sub">Your role has no notification events available.</p>
          )}
        </div>
        {allowedEvents.length < N_EVENTS.length && (
          <p className="sub" style={{ marginTop: 10 }}>Some event types are only available to roles that can view commissions.</p>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setPrefsOpen(false)}>Cancel</button>
          <button className="btn" onClick={savePrefs}>Save</button>
        </div>
      </Modal>
    </div>
  );
}
