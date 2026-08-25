import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notificationsApi, type Notification, type NotificationEvent } from '../api/endpoints';
import { useCurrentSession } from '../hooks/useCurrentSession';
import { Money, Pill } from './ui';

const EVENT_TAGS: Record<NotificationEvent, { label: string; tone: 'ok' | 'no' }> = {
  'payment.paid': { label: 'Paid', tone: 'ok' },
  'payment.failed': { label: 'Declined', tone: 'no' },
  'payment.refunded': { label: 'Refund', tone: 'no' },
  'payment.chargeback': { label: 'Chargeback', tone: 'no' },
  'payout.paid': { label: 'Payout', tone: 'ok' },
};

function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function NotificationRow({ notification, onRead }: { notification: Notification; onRead: () => void }) {
  const tag = EVENT_TAGS[notification.event];
  const body = (
    <>
      <span className="nic"><Pill tone={tag.tone}>{tag.label}</Pill></span>
      <div>
        <div className="ntitle">
          {notification.title}
          {notification.amount !== null && (
            <> · <Money amount={notification.amount} currency={notification.currency ?? undefined} /></>
          )}
        </div>
        <div className="nmeta">
          {notification.body ? `${notification.body} · ` : ''}
          {timeAgo(notification.createdAt)}
        </div>
      </div>
    </>
  );
  // An unread row is an action (mark read), so it is a button; a read row is just text.
  return notification.read
    ? <div className="nrow">{body}</div>
    : <button type="button" className="nrow unread clickable" onClick={onRead} aria-label={`Mark read: ${notification.title}`}>{body}</button>;
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeWorkspaceId } = useCurrentSession();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const queryKey = ['notifications', activeWorkspaceId];

  const query = useQuery({
    queryKey,
    queryFn: () => notificationsApi.list(),
    enabled: Boolean(activeWorkspaceId),
    refetchInterval: 60_000,
  });

  const markRead = useMutation({
    mutationFn: (ids?: string[]) => notificationsApi.markRead(ids),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const unread = query.data?.unread ?? 0;
  const notifications = query.data?.notifications ?? [];

  const openPreferences = () => {
    setOpen(false);
    navigate('/settings?tab=notifications');
  };

  return (
    <div ref={wrapRef} className="bell-wrap">
      <button
        type="button"
        className="bell-btn"
        title="Notifications"
        aria-label="Notifications"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span className={unread > 0 ? 'bell-dot on' : 'bell-dot'}>{unread > 9 ? '9+' : unread}</span>
      </button>

      <div className={open ? 'bell-panel on' : 'bell-panel'}>
        <div className="bell-head">
          <strong>Notifications</strong>
          {unread > 0 && (
            <button type="button" className="btn ghost small" onClick={() => markRead.mutate(undefined)}>
              Mark all read
            </button>
          )}
          <button type="button" className="btn ghost small" onClick={openPreferences}>
            Preferences
          </button>
        </div>

        {query.isLoading && (
          <div className="nrow"><span className="nmeta">Loading…</span></div>
        )}
        {query.isError && (
          <div className="nrow"><span className="nmeta">Couldn't load notifications.</span></div>
        )}
        {query.isSuccess && notifications.length === 0 && (
          <div className="nrow"><span className="nmeta">Nothing yet.</span></div>
        )}
        {notifications.map((n) => (
          <NotificationRow key={n.id} notification={n} onRead={() => markRead.mutate([n.id])} />
        ))}
      </div>
    </div>
  );
}
