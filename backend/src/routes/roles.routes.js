'use strict';
// Custom roles: named permission sets that belong to one workspace. A role is
// a shortcut for filling in a seat's permissions. The seat keeps its own copy
// (workspace_users.permissions, what every request reads); editing a role
// rewrites the copy of every seat that uses it. The seat's structural type
// (member, admin, agent, creator) is separate and never changes here, so data
// scope and the agent / creator profiles are untouched.
const express = require('express');
const { query, withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { PERMISSIONS, validateGrantablePermissions } = require('../auth/permissions');
const { newCustomRoleKey } = require('../services/workspaceRoles');
const { isStr, badRequest } = require('../util/validate');
const { wid, uid } = require('../lib/scope');

const router = express.Router({ mergeParams: true });

const publicRole = (row) => ({
  key: row.key,
  name: row.name,
  permissions: row.permissions,
  memberCount: Number(row.member_count || 0),
});

const ROLE_SELECT = `
  SELECT wr.key, wr.name, wr.permissions,
         (SELECT count(*) FROM workspace_users wu
           WHERE wu.workspace_id = wr.workspace_id AND wu.custom_role_key = wr.key
             AND wu.status <> 'removed')::int AS member_count
    FROM workspace_roles wr`;

router.get('/', requirePermission('team.view'), asyncHandler(async (req, res) => {
  const rows = (await query(
    `${ROLE_SELECT} WHERE wr.workspace_id = $1 AND NOT wr.is_system ORDER BY wr.name`, [wid(req)])).rows;
  res.json({ roles: rows.map(publicRole), permissions: PERMISSIONS });
}));

router.post('/', requirePermission('roles.manage'), asyncHandler(async (req, res) => {
  const { name, permissions } = req.body || {};
  if (!isStr(name, 80)) return badRequest(res, 'a role name of 1 to 80 characters is required', ['name']);
  const permissionError = validateGrantablePermissions(req.access, permissions);
  if (permissionError) return res.status(400).json({ error: permissionError });

  const duplicate = (await query(
    'SELECT 1 FROM workspace_roles WHERE workspace_id=$1 AND lower(name)=lower($2)', [wid(req), name.trim()])).rows[0];
  if (duplicate) return res.status(409).json({ error: 'role_name_in_use', detail: 'a role with this name already exists' });

  const row = (await query(
    `INSERT INTO workspace_roles (workspace_id, key, name, permissions, is_system)
     VALUES ($1,$2,$3,$4,false)
     RETURNING key, name, permissions, 0::int AS member_count`,
    [wid(req), newCustomRoleKey(), name.trim(), permissions])).rows[0];
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'role.create',
    entityType: 'role', metadata: { key: row.key, name: row.name, permissions },
  });
  res.status(201).json(publicRole(row));
}));

router.patch('/:key', requirePermission('roles.manage'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const hasName = Object.hasOwn(body, 'name');
  const hasPermissions = Object.hasOwn(body, 'permissions');
  if (!hasName && !hasPermissions) return res.status(400).json({ error: 'no_changes' });
  if (hasName && !isStr(body.name, 80)) return badRequest(res, 'a role name of 1 to 80 characters is required', ['name']);
  if (hasPermissions) {
    const permissionError = validateGrantablePermissions(req.access, body.permissions);
    if (permissionError) return res.status(400).json({ error: permissionError });
  }

  const out = await withTransaction(async (client) => {
    const current = (await client.query(
      'SELECT key, name, permissions FROM workspace_roles WHERE workspace_id=$1 AND key=$2 AND NOT is_system FOR UPDATE',
      [wid(req), req.params.key])).rows[0];
    if (!current) return { error: 'not_found', status: 404 };
    if (hasName) {
      const duplicate = (await client.query(
        'SELECT 1 FROM workspace_roles WHERE workspace_id=$1 AND key<>$2 AND lower(name)=lower($3)',
        [wid(req), current.key, body.name.trim()])).rows[0];
      if (duplicate) return { error: 'role_name_in_use', status: 409 };
    }
    const nextName = hasName ? body.name.trim() : current.name;
    const nextPermissions = hasPermissions ? body.permissions : current.permissions;
    await client.query(
      'UPDATE workspace_roles SET name=$3, permissions=$4 WHERE workspace_id=$1 AND key=$2',
      [wid(req), current.key, nextName, nextPermissions]);
    // Every seat on this role follows it.
    if (hasPermissions) {
      await client.query(
        'UPDATE workspace_users SET permissions=$3 WHERE workspace_id=$1 AND custom_role_key=$2',
        [wid(req), current.key, nextPermissions]);
    }
    const row = (await client.query(
      `${ROLE_SELECT} WHERE wr.workspace_id=$1 AND wr.key=$2`, [wid(req), current.key])).rows[0];
    return { row, before: current };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'role.update', entityType: 'role',
    metadata: { key: out.row.key, before: out.before, after: { name: out.row.name, permissions: out.row.permissions } },
  });
  res.json(publicRole(out.row));
}));

router.delete('/:key', requirePermission('roles.manage'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (client) => {
    const role = (await client.query(
      'SELECT key FROM workspace_roles WHERE workspace_id=$1 AND key=$2 AND NOT is_system FOR UPDATE',
      [wid(req), req.params.key])).rows[0];
    if (!role) return { error: 'not_found', status: 404 };
    const used = (await client.query(
      'SELECT 1 FROM workspace_users WHERE workspace_id=$1 AND custom_role_key=$2 LIMIT 1',
      [wid(req), role.key])).rows[0];
    if (used) return { error: 'role_in_use', status: 409, detail: 'move the members on this role to another role first' };
    await client.query('DELETE FROM workspace_roles WHERE workspace_id=$1 AND key=$2', [wid(req), role.key]);
    return {};
  });
  if (out.error) return res.status(out.status).json({ error: out.error, detail: out.detail });
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'role.delete',
    entityType: 'role', metadata: { key: req.params.key },
  });
  res.status(204).end();
}));

module.exports = router;
