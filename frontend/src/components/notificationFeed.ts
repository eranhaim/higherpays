import type { Notification } from '../api/endpoints';

export interface NotificationFeed {
  unread: number;
  notifications: Notification[];
}

export function markNotificationsRead(feed: NotificationFeed, ids?: string[]): NotificationFeed {
  const readIds = ids ? new Set(ids) : null;
  return {
    unread: readIds
      ? Math.max(0, feed.unread - feed.notifications.filter((item) => !item.read && readIds.has(item.id)).length)
      : 0,
    notifications: feed.notifications.map((item) => ({
      ...item,
      read: !readIds || readIds.has(item.id) ? true : item.read,
    })),
  };
}
