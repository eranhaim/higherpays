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
  | 'creators.view' | 'creators.manage'
  | 'compliance.view' | 'compliance.manage'
  | 'customers.view' | 'customers.manage' | 'customers.export'
  | 'sales.view'
  | 'commissions.view' | 'commissions.manage'
  | 'team.view' | 'team.manage'
  | 'settings.view' | 'settings.edit' | 'settings.danger';

export const PERMISSION_LABELS: Record<Permission, string> = {
  'payments.view': 'View payments',
  'payments.export': 'Export payments',
  'links.view': 'View payment links',
  'links.create': 'Create payment links',
  'analytics.view': 'View analytics',
  'workspaces.view': 'View workspaces',
  'workspaces.create': 'Create workspaces',
  'creators.view': 'View creators',
  'creators.manage': 'Manage creators',
  'compliance.view': 'View compliance',
  'compliance.manage': 'Manage compliance',
  'customers.view': 'View customers',
  'customers.manage': 'Manage customers',
  'customers.export': 'Export customers',
  'sales.view': 'View sales',
  'commissions.view': 'View commissions and payouts',
  'commissions.manage': 'Manage commissions and payouts',
  'team.view': 'View team',
  'team.manage': 'Manage team',
  'settings.view': 'View settings',
  'settings.edit': 'Edit settings',
  'settings.danger': 'Danger zone',
};

export const ALL_PERMISSIONS = Object.keys(PERMISSION_LABELS) as Permission[];

/**
 * Built-in matrix, used only until the workspace's own role definitions have
 * loaded. Keep in sync with the backend.
 */
export const SYSTEM_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS.filter((p) => p !== 'settings.danger'),
  manager: [
    'payments.view', 'links.view', 'links.create', 'analytics.view', 'workspaces.view',
    'creators.view', 'creators.manage', 'compliance.view', 'customers.view', 'sales.view',
    'commissions.view', 'team.view', 'settings.view',
  ],
  analyst: [
    'payments.view', 'payments.export', 'links.view', 'analytics.view', 'workspaces.view',
    'creators.view', 'compliance.view', 'customers.view', 'sales.view', 'commissions.view',
    'team.view', 'settings.view',
  ],
  chatter: ['analytics.view', 'payments.view', 'links.view', 'links.create', 'creators.view', 'customers.view', 'sales.view'],
  creator: ['analytics.view', 'payments.view'],
};
