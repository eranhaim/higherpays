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
  | 'payments' | 'links' | 'analytics' | 'payouts' | 'settlements'
  | 'accounts' | 'agents' | 'customers' | 'team' | 'settings';

export interface NavItem {
  path: string;
  label: string;
  labelKey?: keyof WorkspaceLabels;
  /**
   * What the page is called for someone who sees only their own rows. The
   * payouts page is "Earnings" to the person being paid.
   */
  scopedLabel?: string;
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
      { path: '/payouts', label: 'Payouts', scopedLabel: 'Earnings', perm: 'analytics.view', icon: 'payouts' },
      { path: '/settlements', label: 'Settlements', perm: 'revenue.view', icon: 'settlements' },
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
      // Everyone has personal settings (2FA, sessions, notifications); the
      // workspace tabs inside gate themselves on settings.view.
      { path: '/settings', label: 'Settings', perm: 'payments.view', icon: 'settings' },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

export const ROUTE_PERMISSION: Record<string, Permission> =
  Object.fromEntries(NAV_ITEMS.map((i) => [i.path, i.perm]));

export function navLabel(item: NavItem, labels: WorkspaceLabels, seesWholeWorkspace: boolean): string {
  if (item.labelKey) return labels[item.labelKey];
  if (item.scopedLabel && !seesWholeWorkspace) return item.scopedLabel;
  return item.label;
}
