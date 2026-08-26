/**
 * The one table mapping a page to the permission that opens it. The sidebar
 * filters from it and the route guard gates from it, so a page can never be
 * hidden from the nav yet reachable by typing its URL.
 *
 * Account and agent pages take their label from the workspace, which names
 * them its own way ("Creators", "Chatters"); `labelKey` says which.
 */

import type { Permission } from './permissions';
import type { WorkspaceLabels } from '../api/types';

export type NavIconName =
  | 'payments' | 'links' | 'analytics' | 'payouts'
  | 'accounts' | 'agents' | 'customers' | 'team' | 'settings';

export interface NavItem {
  path: string;
  label: string;
  labelKey?: keyof WorkspaceLabels;
  perm: Permission;
  icon: NavIconName;
}
export interface NavGroup { label: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  {
    label: 'Operate',
    items: [
      { path: '/payments', label: 'Payments', perm: 'payments.view', icon: 'payments' },
      { path: '/links', label: 'Payment links', perm: 'links.view', icon: 'links' },
      { path: '/analytics', label: 'Analytics', perm: 'analytics.view', icon: 'analytics' },
      { path: '/payouts', label: 'Payouts', perm: 'revenue.view', icon: 'payouts' },
    ],
  },
  {
    label: 'Manage',
    items: [
      { path: '/accounts', label: 'Accounts', labelKey: 'accounts', perm: 'accounts.view', icon: 'accounts' },
      { path: '/agents', label: 'Agents', labelKey: 'agents', perm: 'agents.view', icon: 'agents' },
      { path: '/customers', label: 'Customers', perm: 'customers.view', icon: 'customers' },
    ],
  },
  {
    label: 'Administer',
    items: [
      { path: '/team', label: 'Team', perm: 'team.view', icon: 'team' },
      { path: '/settings', label: 'Settings', perm: 'settings.view', icon: 'settings' },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

export const ROUTE_PERMISSION: Record<string, Permission> =
  Object.fromEntries(NAV_ITEMS.map((i) => [i.path, i.perm]));

export function navLabel(item: NavItem, labels: WorkspaceLabels): string {
  return item.labelKey ? labels[item.labelKey] : item.label;
}
