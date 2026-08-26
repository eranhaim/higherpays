/**
 * The one table mapping a page to the permission that opens it. The sidebar
 * filters from it and the route guard gates from it, so a page can never be
 * hidden from the nav yet reachable by typing its URL.
 */

import type { Permission } from './permissions';

export type NavIconName =
  | 'payments' | 'links' | 'analytics' | 'payouts'
  | 'accounts' | 'customers' | 'team' | 'workspaces' | 'settings';

export interface NavItem { path: string; label: string; perm: Permission; icon: NavIconName }
export interface NavGroup { label: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  {
    label: 'Operate',
    items: [
      { path: '/payments', label: 'Payments', perm: 'payments.view', icon: 'payments' },
      { path: '/links', label: 'Payment links', perm: 'links.view', icon: 'links' },
      { path: '/analytics', label: 'Analytics', perm: 'analytics.view', icon: 'analytics' },
      { path: '/payouts', label: 'Payouts', perm: 'commissions.view', icon: 'payouts' },
    ],
  },
  {
    label: 'Manage',
    items: [
      { path: '/accounts', label: 'Accounts', perm: 'accounts.view', icon: 'accounts' },
      { path: '/customers', label: 'Customers', perm: 'customers.view', icon: 'customers' },
    ],
  },
  {
    label: 'Administer',
    items: [
      { path: '/workspaces', label: 'Workspaces', perm: 'workspaces.view', icon: 'workspaces' },
      { path: '/team', label: 'Team', perm: 'team.view', icon: 'team' },
      { path: '/settings', label: 'Settings', perm: 'settings.view', icon: 'settings' },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

export const ROUTE_PERMISSION: Record<string, Permission> =
  Object.fromEntries(NAV_ITEMS.map((i) => [i.path, i.perm]));
