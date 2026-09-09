'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { PERMISSIONS } = require('../auth/permissions');
const {
  FIXED_PERMISSION_ROLES, ensureWorkspaceRoles, newRoleKey, validateRolePermissions,
} = require('../services/workspaceRoles');
const { wid, uid } = require('../lib/scope');

const router = express.Router({ mergeParams: true });

const publicRole = (row) => ({
  key: row.key,
  name: row.name,
  permissions: row.permissions,
  isSystem: row.is_system,
  permissionsFixed: FIXED_PERMISSION_ROLES.has(row.key),
  memberCount: Number(row.member_count || 0),
});

async function roleRows(client, workspaceId) {
  await ensureWorkspaceRoles(client, workspaceId);
  return (await client.query(
    `SELECT wr.key, wr.name, wr.permissions, wr.is_system,
            count(wu.user_id)::int AS member_count
       FROM workspace_roles wr
       LEFT JOIN workspace_users wu
         ON wu.workspace_id=wr.workspace_id AND wu.role=wr.key
      WHERE wr.workspace_id=$1
      GROUP BY wr.workspace_id, wr.key
      ORDER BY wr.is_system DESC, wr.name`,
    [workspaceId])).rows;
}

function validateInputPermissions(req, permissions) {
  return validateRolePermissions(permissions, [...req.access.permissions]);
}

router.get('/', requirePermission('team.view'), asyncHandler(async (req, res) => {
  const roles = await withTransaction((client) => roleRows(client, wid(req)));
  res.json({ roles: roles.map(publicRole), permissions: PERMISSIONS });
}));

router.post('/', requirePermission('roles.manage'), asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const permissions = req.body?.permissions ?? [];
  if (!name || name.length > 80) return res.status(400).json({ error: 'name_invalid' });
  const permissionError = validateInputPermissions(req, permissions);
  if (permissionError) return res.status(400).json({ error: permissionError });
  if (!permissions.includes('data.view_all')) {
    return res.status(400).json({ error: 'custom_role_requires_workspace_scope' });
  }

  const duplicate = (await query(
    'SELECT 1 FROM workspace_roles WHERE workspace_id=$1 AND lower(name)=lower($2)',
    [wid(req), name])).rows[0];
  if (duplicate) return res.status(409).json({ error: 'role_name_in_use' });

  const row = (await query(
    `INSERT INTO workspace_roles (workspace_id, key, name, permissions)
     VALUES ($1,$2,$3,$4)
     RETURNING key, name, permissions, is_system, 0::int AS member_count`,
    [wid(req), newRoleKey(), name, permissions])).rows[0];
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'role.create',
    entityType: 'role', metadata: { key: row.key, name, permissions },
  });
  res.status(201).json(publicRole(row));
}));

router.patch('/:key', requirePermission('roles.manage'), asyncHandler(async (req, res) => {
  const hasName = Object.hasOwn(req.body || {}, 'name');
  const hasPermissions = Object.hasOwn(req.body || {}, 'permissions');
  if (!hasName && !hasPermissions) return res.status(400).json({ error: 'no_changes' });
  const name = hasName ? String(req.body.name || '').trim() : null;
  if (hasName && (!name || name.length > 80)) return res.status(400).json({ error: 'name_invalid' });
  if (hasPermissions) {
    const permissionError = validateInputPermissions(req, req.body.permissions);
    if (permissionError) return res.status(400).json({ error: permissionError });
  }

  const out = await withTransaction(async (client) => {
    const current = (await client.query(
      'SELECT key, name, permissions, is_system FROM workspace_roles WHERE workspace_id=$1 AND key=$2 FOR UPDATE',
      [wid(req), req.params.key])).rows[0];
    if (!current) return { error: 'not_found', status: 404 };
    if (current.is_system && hasName) return { error: 'system_role_name_fixed', status: 400 };
    if (FIXED_PERMISSION_ROLES.has(current.key) && hasPermissions) {
      return { error: 'system_role_permissions_fixed', status: 400 };
    }
    if (!FIXED_PERMISSION_ROLES.has(current.key) && hasPermissions
        && !req.body.permissions.includes('data.view_all')) {
      return { error: 'plain_role_requires_workspace_scope', status: 400 };
    }
    if (hasName) {
      const duplicate = (await client.query(
        'SELECT 1 FROM workspace_roles WHERE workspace_id=$1 AND key<>$2 AND lower(name)=lower($3)',
        [wid(req), current.key, name])).rows[0];
      if (duplicate) return { error: 'role_name_in_use', status: 409 };
    }
    const row = (await client.query(
      `UPDATE workspace_roles
          SET name=CASE WHEN $3::boolean THEN $4 ELSE name END,
              permissions=CASE WHEN $5::boolean THEN $6::text[] ELSE permissions END
        WHERE workspace_id=$1 AND key=$2
        RETURNING key, name, permissions, is_system`,
      [wid(req), current.key, hasName, name, hasPermissions, hasPermissions ? req.body.permissions : []])).rows[0];
    const count = (await client.query(
      'SELECT count(*)::int AS count FROM workspace_users WHERE workspace_id=$1 AND role=$2',
      [wid(req), current.key])).rows[0].count;
    return { row: { ...row, member_count: count }, before: current };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'role.update',
    entityType: 'role', metadata: { key: out.row.key, before: out.before, after: out.row },
  });
  res.json(publicRole(out.row));
}));

router.delete('/:key', requirePermission('roles.manage'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (client) => {
    const role = (await client.query(
      'SELECT is_system FROM workspace_roles WHERE workspace_id=$1 AND key=$2 FOR UPDATE',
      [wid(req), req.params.key])).rows[0];
    if (!role) return { error: 'not_found', status: 404 };
    if (role.is_system) return { error: 'system_role_fixed', status: 400 };
    const used = (await client.query(
      `SELECT 1 FROM workspace_users WHERE workspace_id=$1 AND role=$2
       UNION ALL
       SELECT 1 FROM invites WHERE workspace_id=$1 AND role=$2 AND accepted_at IS NULL
       LIMIT 1`,
      [wid(req), req.params.key])).rows[0];
    if (used) return { error: 'role_in_use', status: 409 };
    await client.query('DELETE FROM workspace_roles WHERE workspace_id=$1 AND key=$2',
      [wid(req), req.params.key]);
    return {};
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'role.delete',
    entityType: 'role', metadata: { key: req.params.key },
  });
  res.status(204).end();
}));

module.exports = router;
