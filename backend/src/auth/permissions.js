'use strict';
// The permission matrix. Permissions live in code, keyed by workspace role;
// the frontend mirrors this list for what it shows, the server enforces it.

const { status } = require('../schema/entities');

const PERMISSIONS = [
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

// `data.view_all` is the scope marker: a role that holds it sees the whole
// workspace. Without it a caller is narrowed to their own rows — an agent to
// the accounts they work, an account owner to their own account.
const ROLE_PERMISSIONS = {
  workspace_admin: new Set(PERMISSIONS),

  analyst: new Set([
    'payments.view', 'payments.export',
    'links.view',
    'analytics.view',
    'accounts.view',
    'agents.view',
    'customers.view',
    'revenue.view',
    'team.view',
    'settings.view',
    'data.view_all',
  ]),

  // Sells for the accounts they are assigned, completes the details on a paid
  // payment, and sees only their own work.
  agent: new Set([
    'payments.view', 'payments.complete',
    'links.view', 'links.create',
    'analytics.view',
    'accounts.view',
    'customers.view', 'customers.manage',
  ]),

  // Their own dashboard only.
  account_owner: new Set([
    'payments.view',
    'links.view',
    'analytics.view',
  ]),
};

function can(role, permission) {
  const set = ROLE_PERMISSIONS[role];
  return !!set && set.has(permission);
}

function hasPermission(access, permission) {
  if (!access) return false;
  return access.permissions.has(permission);
}

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, WORKSPACE_ROLE: status.WORKSPACE_ROLE, can, hasPermission };
