/**
 * The one table mapping a page to the permission that opens it. The sidebar
 * filters from it and the route guard gates from it, so a page can never be
 * hidden from the nav yet reachable by typing its URL.
 *
 * Agency management lives under one destination; its internal sections use
 * the workspace labels ("Creators", "Chatters") where appropriate.
 */

import type { Permission } from './permissions';
import type { WorkspaceLabels } from '../api/types';

export type NavIconName =
  | 'payments' | 'links' | 'analytics' | 'payouts'
  | 'accounts' | 'agents' | 'customers' | 'team' | 'archive' | 'settings';

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
    ],
  },
  {
    label: 'Manage',
    items: [
      { path: '/agency', label: 'Agency', perm: 'accounts.view', icon: 'accounts' },
      { path: '/customers', label: 'Customers', perm: 'customers.view', icon: 'customers' },
    ],
  },
  {
    label: 'Administer',
    items: [
      { path: '/archive', label: 'Archive', perm: 'archive.manage', icon: 'archive' },
      // Everyone has personal settings (2FA, sessions, notifications); the
      // workspace tabs inside gate themselves on settings.view.
      { path: '/settings', label: 'Settings', perm: 'payments.view', icon: 'settings' },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

export const ROUTE_PERMISSION: Record<string, Permission> =
  {
    ...Object.fromEntries(NAV_ITEMS.map((i) => [i.path, i.perm])),
    // Keep existing bookmarks guarded while App redirects them to Agency.
    '/accounts': 'accounts.view',
    '/agents': 'agents.view',
    '/team': 'team.view',
  };

export function navLabel(item: NavItem, labels: WorkspaceLabels, seesWholeWorkspace: boolean): string {
  if (item.labelKey) return labels[item.labelKey];
  if (item.scopedLabel && !seesWholeWorkspace) return item.scopedLabel;
  return item.label;
}
