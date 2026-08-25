/**
 * The one table mapping a page to the permission that opens it. The sidebar
 * filters from it and the route guard gates from it, so a page can never be
 * hidden from the nav yet reachable by typing its URL.
 */

import type { Permission } from './permissions';

export interface NavItem { path: string; label: string; perm: Permission }
export interface NavGroup { label: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  {
    label: 'Money in',
    items: [
      { path: '/payments', label: 'Payments', perm: 'payments.view' },
      { path: '/links', label: 'Payment links', perm: 'links.view' },
    ],
  },
  {
    label: 'Money out',
    items: [
      { path: '/payouts', label: 'Payouts', perm: 'commissions.view' },
    ],
  },
  {
    label: 'People',
    items: [
      { path: '/accounts', label: 'Accounts', perm: 'accounts.view' },
      { path: '/customers', label: 'Customers', perm: 'customers.view' },
      { path: '/team', label: 'Team', perm: 'team.view' },
    ],
  },
  {
    label: 'Insight',
    items: [
      { path: '/analytics', label: 'Analytics', perm: 'analytics.view' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { path: '/settings', label: 'Settings', perm: 'settings.view' },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

export const ROUTE_PERMISSION: Record<string, Permission> =
  Object.fromEntries(NAV_ITEMS.map((i) => [i.path, i.perm]));
