'use strict';

const crypto = require('crypto');
const { PERMISSIONS, ROLE_PERMISSIONS } = require('../auth/permissions');

const SYSTEM_ROLE_NAMES = {
  workspace_owner: 'Owner',
  workspace_admin: 'Admin',
  analyst: 'Analyst',
  agent: 'Agent',
  account_owner: 'Creator',
};

const SYSTEM_ROLE_KEYS = Object.keys(SYSTEM_ROLE_NAMES);

function defaultRoleRows() {
  return SYSTEM_ROLE_KEYS.map((key) => ({
    key,
    name: SYSTEM_ROLE_NAMES[key],
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

function validPermissions(permissions) {
  return Array.isArray(permissions)
    && permissions.every((permission) => PERMISSIONS.includes(permission));
}

module.exports = {
  SYSTEM_ROLE_NAMES,
  SYSTEM_ROLE_KEYS,
  defaultRoleRows,
  ensureWorkspaceRoles,
  newRoleKey,
  validPermissions,
};
