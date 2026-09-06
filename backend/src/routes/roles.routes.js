'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, badRequest } = require('../util/validate');
const { PERMISSIONS } = require('../auth/permissions');
const {
  ensureWorkspaceRoles, newRoleKey, validPermissions,
} = require('../services/workspaceRoles');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

async function listRoles(c, workspaceId) {
  await ensureWorkspaceRoles(c, workspaceId);
  return (await c.query(
    `SELECT wr.key, wr.name, wr.permissions, wr.is_system,
            count(wu.user_id)::int AS member_count
       FROM workspace_roles wr
       LEFT JOIN workspace_users wu
         ON wu.workspace_id = wr.workspace_id AND wu.role = wr.key
      WHERE wr.workspace_id = $1
      GROUP BY wr.workspace_id, wr.key
      ORDER BY wr.is_system DESC, wr.name`,
    [workspaceId])).rows;
}

function publicRole(r) {
  return {
    key: r.key,
    name: r.name,
    permissions: r.permissions,
    isSystem: r.is_system,
    memberCount: Number(r.member_count || 0),
  };
}

router.get('/', requirePermission('team.view'), asyncHandler(async (req, res) => {
  const roles = await withTransaction((c) => listRoles(c, wid(req)));
  res.json({ roles: roles.map(publicRole), permissions: PERMISSIONS });
}));

router.post('/', requirePermission('roles.manage'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!isStr(body.name, 80)) return badRequest(res, 'name is required', ['name']);
  if (body.permissions != null && !validPermissions(body.permissions)) {
    return badRequest(res, 'permissions contains an unknown permission', ['permissions']);
  }
  const key = newRoleKey();
  const row = (await query(
    `INSERT INTO workspace_roles (workspace_id, key, name, permissions, is_system)
     VALUES ($1,$2,$3,$4,false)
     RETURNING key, name, permissions, is_system, 0::int AS member_count`,
    [wid(req), key, body.name.trim(), body.permissions || []])).rows[0];
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'role.create',
    entityType: 'role', entityId: key, metadata: { name: row.name, permissions: row.permissions },
  });
  res.status(201).json(publicRole(row));
}));

router.patch('/:key', requirePermission('roles.manage'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (body.permissions != null && !validPermissions(body.permissions)) {
    return badRequest(res, 'permissions contains an unknown permission', ['permissions']);
  }
  if ('name' in body && !isStr(body.name, 80)) return badRequest(res, 'name is required', ['name']);
  if (req.params.key === 'workspace_owner') return res.status(403).json({ error: 'owner_permissions_fixed' });
  if (body.permissions == null && !('name' in body)) return badRequest(res, 'no updatable fields provided');

  const out = await withTransaction(async (c) => {
    const current = (await c.query(
      'SELECT key, name, permissions, is_system FROM workspace_roles WHERE workspace_id=$1 AND key=$2',
      [wid(req), req.params.key])).rows[0];
    if (!current) return { err: 'not_found', code: 404 };
    if (current.is_system && 'name' in body) return { err: 'system_role_name_fixed', code: 400 };

    const fields = [];
    const values = [];
    if ('name' in body) {
      values.push(body.name.trim());
      fields.push(`name=$${values.length}`);
    }
    if (body.permissions != null) {
      values.push(body.permissions);
      fields.push(`permissions=$${values.length}`);
    }
    values.push(wid(req), req.params.key);
    const row = (await c.query(
      `UPDATE workspace_roles SET ${fields.join(', ')}
        WHERE workspace_id=$${values.length - 1} AND key=$${values.length}
        RETURNING key, name, permissions, is_system`,
      values)).rows[0];
    return { row: { ...row, member_count: (await c.query(
      'SELECT count(*)::int AS member_count FROM workspace_users WHERE workspace_id=$1 AND role=$2',
      [wid(req), req.params.key])).rows[0].member_count } };
  });
  if (out.err) return res.status(out.code).json({ error: out.err });
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'role.update',
    entityType: 'role', entityId: out.row.key, metadata: body,
  });
  res.json(publicRole(out.row));
}));

router.delete('/:key', requirePermission('roles.manage'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const role = (await c.query(
      'SELECT is_system FROM workspace_roles WHERE workspace_id=$1 AND key=$2',
      [wid(req), req.params.key])).rows[0];
    if (!role) return { err: 'not_found', code: 404 };
    if (role.is_system) return { err: 'system_role_fixed', code: 400 };
    const member = (await c.query(
      'SELECT 1 FROM workspace_users WHERE workspace_id=$1 AND role=$2 LIMIT 1',
      [wid(req), req.params.key])).rows[0];
    if (member) return { err: 'role_in_use', code: 409 };
    await c.query('DELETE FROM workspace_roles WHERE workspace_id=$1 AND key=$2', [wid(req), req.params.key]);
    return {};
  });
  if (out.err) return res.status(out.code).json({ error: out.err });
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'role.delete',
    entityType: 'role', entityId: req.params.key,
  });
  res.status(204).end();
}));

module.exports = router;
