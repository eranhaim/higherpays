/**
 * The one table mapping a page to the permission that opens it. The sidebar
 * filters from it and the route guard gates from it, so a page can never be
 * hidden from the nav yet reachable by typing its URL.
 *
 * Agency management is one destination: a single members list covering
 * creators, agents, admins and pending invites.
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
  /** What opens the page. A list means any one of them is enough. */
  perm: Permission | Permission[];
  icon: NavIconName;
}
export interface NavGroup { label: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  {
    label: 'Operate',
    items: [
      { path: '/payments', label: 'Payments', perm: 'payments.view', icon: 'payments' },
      // Seeing links is not a reason to open this page: every control on it —
      // create, cancel, fill in details — needs links.create, so an
      // account_owner got a read-only list with nothing to do. Reviewing the
      // whole workspace (data.view_all) is the other reason it is worth
      // opening, which is what an analyst has instead of links.create.
      { path: '/links', label: 'Payment links', perm: ['links.create', 'data.view_all'], icon: 'links' },
      { path: '/analytics', label: 'Analytics', perm: 'analytics.view', icon: 'analytics' },
      { path: '/payouts', label: 'Payouts', scopedLabel: 'Earnings', perm: 'analytics.view', icon: 'payouts' },
    ],
  },
  {
    label: 'Manage',
    items: [
      // The page is the member list, served by GET /team. Opening it on
      // accounts.view alone would render an error instead of a page.
      { path: '/agency', label: 'Agency', perm: 'team.view', icon: 'team' },
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

export const ROUTE_PERMISSION: Record<string, Permission | Permission[]> =
  {
    ...Object.fromEntries(NAV_ITEMS.map((i) => [i.path, i.perm])),
    // Existing bookmarks redirect to Agency, so they are gated on what Agency
    // needs rather than on the permission their old page used.
    '/accounts': 'team.view',
    '/agents': 'team.view',
    '/team': 'team.view',
  };

export function navLabel(item: NavItem, labels: WorkspaceLabels, seesWholeWorkspace: boolean): string {
  if (item.labelKey) return labels[item.labelKey];
  if (item.scopedLabel && !seesWholeWorkspace) return item.scopedLabel;
  return item.label;
}
