import { describe, expect, it } from 'vitest';
import { markNotificationsRead } from './notificationFeed';

const notification = (id: string, read = false) => ({
  id,
  event: 'payment.paid' as const,
  title: 'Payment received',
  body: null,
  amount: 47,
  currency: 'EUR',
  read,
  createdAt: '2026-10-04T12:00:00.000Z',
  entityType: 'payment',
  entityId: id,
});

describe('notification read state', () => {
  it('keeps an individually read notification read while later notifications stay unread', () => {
    const afterRead = markNotificationsRead({
      unread: 2,
      notifications: [notification('reconciled'), notification('new')],
    }, ['reconciled']);

    expect(afterRead.unread).toBe(1);
    expect(afterRead.notifications.map((item) => item.read)).toEqual([true, false]);
  });

  it('marks only the current user feed read', () => {
    const feed = { unread: 2, notifications: [notification('one'), notification('two')] };

    expect(markNotificationsRead(feed).unread).toBe(0);
    expect(feed.unread).toBe(2);
    expect(feed.notifications.every((item) => item.read)).toBe(false);
  });
});
