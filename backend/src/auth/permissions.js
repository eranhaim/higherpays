'use strict';

// Server-side permission matrix. This is the source of truth — the frontend
// role gating is only cosmetic; every protected route checks against this.
//
// The five roles follow "HigherPays — Entity Definitions.md":
//   owner (Workspace Owner), admin, analyst, agent, account.
// Roles are seeded per workspace into the roles table and may be edited there;
// this matrix is the fallback and the definition of the system roles.

const PERMISSIONS = [
  'payments.view', 'payments.export',
  'links.view', 'links.create',
  'analytics.view',
  'workspaces.view', 'workspaces.create',
  'accounts.view', 'accounts.manage',
  'compliance.view', 'compliance.manage',
  'customers.view', 'customers.manage', 'customers.export',
  'commissions.view', 'commissions.manage',
  'fees.view',
  'team.view', 'team.manage',
  'settings.view', 'settings.edit',
  'data.view_all',
];

// `data.view_all` is the scope modifier, not a capability: it decides whether a
// role sees the whole workspace or only its own rows. Roles without it are
// narrowed by resolveDataScope (see auth/dataScope.js) — an agent to what they
// are assigned, an account to itself.
const ROLE_PERMISSIONS = {
  owner: new Set(PERMISSIONS), // everything

  // Identical to owner. The owner/admin boundary is not a permission: it is
  // roleWithinCallerRights refusing to grant `owner`, plus the last-owner guard.
  admin: new Set(PERMISSIONS),

  analyst: new Set([
    'payments.view', 'payments.export',
    'links.view',
    'analytics.view',
    'workspaces.view',
    'accounts.view',
    'compliance.view',
    'customers.view',
    'commissions.view',
    'team.view',
    'settings.view',
    'data.view_all',
  ]),

  // Agent: operational. Creates payment links for the accounts they are
  // assigned to, and sees only their own work.
  agent: new Set([
    'analytics.view',
    'payments.view',
    'links.view', 'links.create',
    'accounts.view',
    'customers.view',
  ]),

  // Account: their own dashboard only — gross, net, own links, own earnings.
  account: new Set([
    'analytics.view',
    'payments.view',
    'links.view',
  ]),
};

function can(role, permission) {
  const set = ROLE_PERMISSIONS[role];
  return !!set && set.has(permission);
}

// The one rule for "does this membership hold this permission": prefer the
// workspace's editable role definition, fall back to the built-in matrix when
// the membership's role has no roles row. Both requirePermission and
// resolveDataScope must use this, or a workspace missing a roles row would be
// gated one way and scoped another.
function hasPermission(membership, permission) {
  if (!membership) return false;
  return membership.permissions
    ? membership.permissions.has(permission)
    : can(membership.role, permission);
}

// Seed the system roles into a workspace's roles table (called on workspace
// creation). After this, roles live in the DB and can be edited or extended.
async function seedRolesForWorkspace(client, workspaceId) {
  for (const [name, perms] of Object.entries(ROLE_PERMISSIONS)) {
    await client.query(
      `INSERT INTO roles (workspace_id, name, permissions, is_system)
       VALUES ($1,$2,$3,true)
       ON CONFLICT (workspace_id, name) DO NOTHING`,
      [workspaceId, name, JSON.stringify([...perms])]
    );
  }
}

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, can, hasPermission, seedRolesForWorkspace };
