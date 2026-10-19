'use strict';
// The fixed membership defaults. A seat keeps its own permission snapshot;
// this matrix only supplies new seats and the migration from legacy roles.

const { status } = require('../schema/entities');

const PERMISSIONS = [
  'payments.view', 'payments.complete', 'payments.export',
  'links.view', 'links.create',
  'archive.manage',
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

  member: new Set([
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

const FULL_ACCESS_ROLES = new Set(['workspace_owner', 'workspace_admin']);

// An owner or admin may grant any permission. Everyone else may only hand on
// what their own seat holds, so nobody can lift a seat above their own level.
function validateGrantablePermissions(access, permissions) {
  const grantable = FULL_ACCESS_ROLES.has(access.role) ? PERMISSIONS : [...access.permissions];
  return validatePermissions(permissions, grantable);
}

// An admin seat can grant every permission whatever list it was created with,
// so only an owner or admin may make one. Otherwise a team manager could
// create an "admin" with a short list and use it to reach the rest.
function canGrantRole(access, role) {
  return !FULL_ACCESS_ROLES.has(role) || FULL_ACCESS_ROLES.has(access.role);
}

// A seat outranks the caller when it is an owner or admin, or holds any
// permission the caller lacks. Such a seat is not theirs to edit, suspend or
// reset, or a team manager could take over the admin's login.
function seatOutranksCaller(access, seat) {
  if (FULL_ACCESS_ROLES.has(access.role)) return false;
  if (FULL_ACCESS_ROLES.has(seat.role)) return true;
  return (seat.permissions || []).some((permission) => !access.permissions.has(permission));
}

module.exports = {
  PERMISSIONS, PERMISSION_DEPENDENCIES, ROLE_PERMISSIONS,
  WORKSPACE_ROLE: status.WORKSPACE_ROLE, can, hasPermission, validatePermissions,
    validateGrantablePermissions, seatOutranksCaller, canGrantRole,
  };
