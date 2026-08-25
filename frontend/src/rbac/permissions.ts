/**
 * Permission vocabulary. Mirrors `backend/src/auth/permissions.js` — the server
 * is the source of truth and enforces every route; this file only drives what
 * the UI shows.
 */

export type Permission =
  | 'payments.view' | 'payments.export'
  | 'links.view' | 'links.create'
  | 'analytics.view'
  | 'workspaces.view' | 'workspaces.create'
  | 'accounts.view' | 'accounts.manage'
  | 'compliance.view' | 'compliance.manage'
  | 'customers.view' | 'customers.manage' | 'customers.export'
  | 'commissions.view' | 'commissions.manage'
  | 'fees.view'
  | 'team.view' | 'team.manage'
  | 'settings.view' | 'settings.edit'
  | 'data.view_all';

export const PERMISSION_LABELS: Record<Permission, string> = {
  'payments.view': 'View payments',
  'payments.export': 'Export payments',
  'links.view': 'View payment links',
  'links.create': 'Create payment links',
  'analytics.view': 'View analytics',
  'workspaces.view': 'View workspaces',
  'workspaces.create': 'Create workspaces',
  'accounts.view': 'View accounts',
  'accounts.manage': 'Manage accounts',
  'compliance.view': 'View compliance',
  'compliance.manage': 'Manage compliance',
  'customers.view': 'View customers',
  'customers.manage': 'Manage customers',
  'customers.export': 'Export customers',
  'commissions.view': 'View commissions and payouts',
  'commissions.manage': 'Manage commissions and payouts',
  'fees.view': 'View fee breakdown and platform margin',
  'team.view': 'View team',
  'team.manage': 'Manage team',
  'settings.view': 'View settings',
  'settings.edit': 'Edit settings',
  'data.view_all': 'See all workspace records, not only your own',
};

export const ALL_PERMISSIONS = Object.keys(PERMISSION_LABELS) as Permission[];

/**
 * Built-in matrix, used only until the workspace's own role definitions have
 * loaded. Keep in sync with the backend.
 */
export const SYSTEM_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: ALL_PERMISSIONS,
  // Identical to owner: the boundary is the server refusing to grant `owner`,
  // plus the last-owner guard — not a permission.
  admin: ALL_PERMISSIONS,
  analyst: [
    'payments.view', 'payments.export', 'links.view', 'analytics.view', 'workspaces.view',
    'accounts.view', 'compliance.view', 'customers.view', 'commissions.view',
    'team.view', 'settings.view', 'data.view_all',
  ],
  agent: ['analytics.view', 'payments.view', 'links.view', 'links.create', 'accounts.view', 'customers.view'],
  account: ['analytics.view', 'payments.view', 'links.view'],
};
