/**
 * Permission vocabulary. Mirrors `backend/src/auth/permissions.js` — the server
 * is the source of truth and enforces every route; this file only drives what
 * the UI shows.
 */

import type { WorkspaceRole } from '../api/types';

export type Permission =
  | 'payments.view' | 'payments.complete' | 'payments.export'
  | 'links.view' | 'links.create'
  | 'analytics.view'
  | 'accounts.view' | 'accounts.manage'
  | 'agents.view' | 'agents.manage'
  | 'customers.view' | 'customers.manage' | 'customers.export'
  | 'revenue.view' | 'revenue.manage'
  | 'fees.view'
  | 'team.view' | 'team.manage'
  | 'settings.view' | 'settings.edit'
  | 'data.view_all';

const ALL: Permission[] = [
  'payments.view', 'payments.complete', 'payments.export',
  'links.view', 'links.create',
  'analytics.view',
  'accounts.view', 'accounts.manage',
  'agents.view', 'agents.manage',
  'customers.view', 'customers.manage', 'customers.export',
  'revenue.view', 'revenue.manage',
  'fees.view',
  'team.view', 'team.manage',
  'settings.view', 'settings.edit',
  'data.view_all',
];

/**
 * Built-in matrix, used only until the workspace's `/permissions` answer has
 * loaded. Keep in sync with the backend.
 */
export const ROLE_PERMISSIONS: Record<WorkspaceRole, Permission[]> = {
  workspace_admin: ALL,
  analyst: [
    'payments.view', 'payments.export', 'links.view', 'analytics.view',
    'accounts.view', 'agents.view', 'customers.view', 'revenue.view',
    'team.view', 'settings.view', 'data.view_all',
  ],
  agent: [
    'payments.view', 'payments.complete', 'links.view', 'links.create',
    'analytics.view', 'accounts.view', 'customers.view', 'customers.manage',
  ],
  account_owner: ['payments.view', 'links.view', 'analytics.view'],
};
