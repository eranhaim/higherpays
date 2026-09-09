'use strict';

const crypto = require('crypto');
const { ROLE_PERMISSIONS, validatePermissions } = require('../auth/permissions');

const SYSTEM_ROLE_NAMES = {
  workspace_owner: 'Owner',
  workspace_admin: 'Admin',
  analyst: 'Analyst',
  agent: 'Agent',
  account_owner: 'Creator',
};

const FIXED_PERMISSION_ROLES = new Set(['workspace_owner', 'agent', 'account_owner']);
const PROFILE_ROLES = new Set(['agent', 'account_owner']);

function defaultRoleRows() {
  return Object.entries(SYSTEM_ROLE_NAMES).map(([key, name]) => ({
    key,
    name,
    permissions: [...(ROLE_PERMISSIONS[key] || [])],
  }));
}

async function ensureWorkspaceRoles(client, workspaceId) {
  for (const role of defaultRoleRows()) {
    await client.query(
      `INSERT INTO workspace_roles (workspace_id, key, name, permissions, is_system)
       VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (workspace_id, key) DO NOTHING`,
      [workspaceId, role.key, role.name, role.permissions]
    );
  }
}

function newRoleKey() {
  return `custom_${crypto.randomBytes(8).toString('hex')}`;
}

function validateRolePermissions(permissions, editorPermissions) {
  return validatePermissions(permissions, editorPermissions);
}

module.exports = {
  SYSTEM_ROLE_NAMES,
  FIXED_PERMISSION_ROLES,
  PROFILE_ROLES,
  ensureWorkspaceRoles,
  newRoleKey,
  validateRolePermissions,
};
