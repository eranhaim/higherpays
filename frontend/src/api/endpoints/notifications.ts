import { api } from '../http';
import { workspacePath } from '../workspacePath';

export type NotificationEvent =
  | 'payment.paid'
  | 'payment.failed'
  | 'payment.refunded'
  | 'payment.chargeback'
  | 'payout.paid';

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  'payment.paid': 'Payment received',
  'payment.failed': 'Payment declined',
  'payment.refunded': 'Refund issued',
  'payment.chargeback': 'Chargeback',
  'payout.paid': 'Payout sent',
};

export interface Notification {
  id: string;
  event: NotificationEvent;
  title: string;
  body: string | null;
  amount: number | null;
  currency: string | null;
  read: boolean;
  createdAt: string;
  entityType: string | null;
  entityId: string | null;
}

export interface NotificationPreferences {
  /** Events the caller's role is allowed to receive. */
  available: NotificationEvent[];
  /** Events the caller currently receives. */
  events: NotificationEvent[];
  usingDefaults: boolean;
}

export interface NotificationChannel {
  id: string;
  type: 'telegram';
  target: string;
  label: string | null;
  events: NotificationEvent[];
  active: boolean;
  lastError: string | null;
  lastSentAt: string | null;
}

export const notificationsApi = {
  list(limit = 30) {
    return api.get<{ unread: number; notifications: Notification[] }>(
      workspacePath(`/notifications?limit=${limit}`),
    );
  },

  /** Marks the given notifications read for the caller; no ids marks everything read. */
  markRead(ids?: string[]) {
    return api.post<{ ok: true }>(workspacePath('/notifications/read'), ids ? { ids } : {});
  },

  getPreferences() {
    return api.get<NotificationPreferences>(workspacePath('/notifications/preferences'));
  },

  setPreferences(events: NotificationEvent[]) {
    return api.put<{ ok: true; events: NotificationEvent[] }>(
      workspacePath('/notifications/preferences'),
      { events },
    );
  },

  listChannels() {
    return api.get<{ channels: NotificationChannel[]; availableEvents: NotificationEvent[] }>(
      workspacePath('/notifications/channels'),
    );
  },

  createChannel(input: { target: string; label?: string; events: NotificationEvent[] }) {
    return api.post<NotificationChannel>(workspacePath('/notifications/channels'), {
      type: 'telegram',
      ...input,
    });
  },

  updateChannel(id: string, input: { active?: boolean; events?: NotificationEvent[] }) {
    return api.patch<NotificationChannel>(workspacePath(`/notifications/channels/${id}`), input);
  },

  deleteChannel(id: string) {
    return api.del<{ ok: true }>(workspacePath(`/notifications/channels/${id}`));
  },

  testChannel(id: string) {
    return api.post<{ ok: true }>(workspacePath(`/notifications/channels/${id}/test`), {});
  },
};
