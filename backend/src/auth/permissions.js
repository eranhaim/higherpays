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
  'roles.manage',
  'settings.view', 'settings.edit',
  'data.view_all',
];

const PERMISSION_DEPENDENCIES = {
  'payments.complete': ['payments.view'],
  'payments.export': ['payments.view'],
  'links.create': ['links.view'],
  'accounts.manage': ['accounts.view'],
  'agents.manage': ['agents.view'],
  'customers.manage': ['customers.view'],
  'customers.export': ['customers.view'],
  'revenue.manage': ['revenue.view'],
  'team.manage': ['team.view'],
  'roles.manage': ['team.view', 'team.manage'],
  'settings.edit': ['settings.view'],
};

// `data.view_all` is the scope marker: a role that holds it sees the whole
// workspace. Without it a caller is narrowed to their own rows — an agent to
// the accounts they work, an account owner to their own account.
const ROLE_PERMISSIONS = {
  workspace_owner: new Set(PERMISSIONS),
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

function validatePermissions(permissions, allowedPermissions = PERMISSIONS) {
  if (!Array.isArray(permissions) || new Set(permissions).size !== permissions.length) {
    return 'permissions_invalid';
  }
  const allowed = new Set(allowedPermissions);
  for (const permission of permissions) {
    if (!PERMISSIONS.includes(permission)) return 'permission_unknown';
    if (!allowed.has(permission)) return 'permission_not_grantable';
    const dependencies = PERMISSION_DEPENDENCIES[permission] || [];
    if (dependencies.some((dependency) => !permissions.includes(dependency))) {
      return 'permission_dependency_missing';
    }
  }
  return null;
}

module.exports = {
  PERMISSIONS, PERMISSION_DEPENDENCIES, ROLE_PERMISSIONS,
  WORKSPACE_ROLE: status.WORKSPACE_ROLE, can, hasPermission, validatePermissions,
};
