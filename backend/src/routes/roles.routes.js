'use strict';
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { PERMISSIONS } = require('../auth/permissions');
const { isStr, badRequest } = require('../util/validate');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

const cleanPerms = (arr) => Array.isArray(arr) ? [...new Set(arr.filter((p) => PERMISSIONS.includes(p)))] : null;

// A caller may only hand out permissions they already hold. Without this an
// admin could write `settings.danger` into any role and become an owner.
function unheldPermissions(req, perms) {
  const held = req.membership.permissions;
  return perms.filter((p) => !(held ? held.has(p) : false));
}

// GET /workspaces/:wid/roles — all roles + their permissions
router.get('/', requirePermission('team.view'), asyncHandler(async (req, res) => {
  const roles = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `SELECT name, permissions, is_system FROM roles WHERE workspace_id=$1 ORDER BY is_system DESC, name`, [wid(req)])).rows);
  res.json({ roles, catalog: PERMISSIONS });
}));

// POST /workspaces/:wid/roles — create a custom role
router.post('/', requirePermission('team.manage'), asyncHandler(async (req, res) => {
  let { name, permissions } = req.body || {};
  if (!isStr(name, 40)) return badRequest(res, 'name is required', ['name']);
  name = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const perms = cleanPerms(permissions) || [];
  const unheld = unheldPermissions(req, perms);
  if (unheld.length) return res.status(403).json({ error: 'cannot_grant_unheld_permission', detail: unheld.join(',') });
  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    const dup = (await c.query('SELECT 1 FROM roles WHERE workspace_id=$1 AND name=$2', [wid(req), name])).rows[0];
    if (dup) return { err: 'role_exists' };
    return { row: (await c.query(
      `INSERT INTO roles (workspace_id, name, permissions, is_system) VALUES ($1,$2,$3,false)
       RETURNING name, permissions, is_system`, [wid(req), name, JSON.stringify(perms)])).rows[0] };
  });
  if (out.err) return res.status(409).json({ error: out.err });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'role.create', metadata: { name, permissions: perms } });
  res.status(201).json(out.row);
}));

// PATCH /workspaces/:wid/roles/:name — set a custom role's permissions.
// System roles are immutable: the owner/admin/manager split is a product
// guarantee, not workspace configuration. Callers cannot edit their own role
// and cannot grant what they do not hold, so nobody can escalate themselves.
router.patch('/:name', requirePermission('team.manage'), asyncHandler(async (req, res) => {
  const perms = cleanPerms(req.body && req.body.permissions);
  if (!perms) return badRequest(res, 'permissions must be an array', ['permissions']);
  if (req.params.name === req.membership.role) return res.status(403).json({ error: 'cannot_edit_own_role' });
  const unheld = unheldPermissions(req, perms);
  if (unheld.length) return res.status(403).json({ error: 'cannot_grant_unheld_permission', detail: unheld.join(',') });

  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    const role = (await c.query('SELECT is_system FROM roles WHERE workspace_id=$1 AND name=$2', [wid(req), req.params.name])).rows[0];
    if (!role) return { err: 'not_found', code: 404 };
    if (role.is_system) return { err: 'system_role_immutable', code: 403 };
    return { row: (await c.query(
      `UPDATE roles SET permissions=$3 WHERE workspace_id=$1 AND name=$2
       RETURNING name, permissions, is_system`, [wid(req), req.params.name, JSON.stringify(perms)])).rows[0] };
  });
  if (out.err) return res.status(out.code).json({ error: out.err });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'role.update', metadata: { name: req.params.name, permissions: perms } });
  res.json(out.row);
}));

// DELETE /workspaces/:wid/roles/:name — remove a custom role (not system, not in use)
router.delete('/:name', requirePermission('team.manage'), asyncHandler(async (req, res) => {
  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    const role = (await c.query('SELECT is_system FROM roles WHERE workspace_id=$1 AND name=$2', [wid(req), req.params.name])).rows[0];
    if (!role) return { err: 'not_found', code: 404 };
    if (role.is_system) return { err: 'cannot_delete_system_role', code: 403 };
    const inUse = (await c.query("SELECT 1 FROM memberships WHERE workspace_id=$1 AND role=$2 AND status='active' LIMIT 1", [wid(req), req.params.name])).rows[0];
    if (inUse) return { err: 'role_in_use', code: 409 };
    await c.query('DELETE FROM roles WHERE workspace_id=$1 AND name=$2', [wid(req), req.params.name]);
    return { ok: true };
  });
  if (out.err) return res.status(out.code).json({ error: out.err });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'role.delete', metadata: { name: req.params.name } });
  res.status(204).end();
}));

module.exports = router;
