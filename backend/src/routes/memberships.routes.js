'use strict';
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { badRequest } = require('../util/validate');
const { revokeUserSessions } = require('../auth/sessions');
const { maxCreatorSplitPct } = require('../services/splits');
const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

// The memberships policy also admits the caller's own rows from OTHER
// workspaces (so login can list them), so every query here filters on
// workspace_id explicitly rather than relying on RLS alone.

// GET / — chatters in this workspace, with each one's own commission rate.
router.get('/', requirePermission('team.view'), asyncHandler(async (req, res) => {
  const rows = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `SELECT m.id, u.full_name AS name, u.email, m.status, m.shift, m.commission_pct
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.role = 'chatter' AND m.status = 'active'
      ORDER BY u.full_name`, [wid(req)])).rows);
  res.json({
    chatters: rows.map((r) => ({
      membershipId: r.id, name: r.name, email: r.email, status: r.status, shift: r.shift,
      commissionPct: r.commission_pct == null ? null : Number(r.commission_pct),
    })),
  });
}));

// GET /members — everyone with an active seat, for managing roles and access.
router.get('/members', requirePermission('team.view'), asyncHandler(async (req, res) => {
  const rows = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `SELECT m.id, m.user_id, u.full_name AS name, u.email, m.role, m.created_at
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.status = 'active'
      ORDER BY m.role, u.full_name`, [wid(req)])).rows);
  res.json({
    members: rows.map((r) => ({
      membershipId: r.id, userId: r.user_id, name: r.name, email: r.email, role: r.role,
      isSelf: r.user_id === uid(req), joinedAt: r.created_at,
    })),
  });
}));

// PATCH /:membershipId  { commissionPct } — set a per-chatter commission %
router.patch('/:membershipId', requirePermission('commissions.manage'), asyncHandler(async (req, res) => {
  const { commissionPct } = req.body || {};
  const v = commissionPct == null || commissionPct === '' ? null : Number(commissionPct);
  if (v != null && !(v >= 0 && v <= 100)) return badRequest(res, 'commissionPct must be 0..100', ['commissionPct']);
  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    if (v != null) {
      const creatorMax = await maxCreatorSplitPct(c, wid(req));
      if (creatorMax + v > 100) return { err: 'split_exceeds_100', detail: `a creator on ${creatorMax}% plus ${v}% commission would exceed 100%` };
    }
    const before = (await c.query(
      'SELECT commission_pct FROM memberships WHERE id=$1 AND workspace_id=$2', [req.params.membershipId, wid(req)])).rows[0];
    if (!before) return { err: 'not_found' };
    const row = (await c.query(
      'UPDATE memberships SET commission_pct=$1 WHERE id=$2 AND workspace_id=$3 RETURNING id, commission_pct',
      [v, req.params.membershipId, wid(req)])).rows[0];
    return { row, previous: before.commission_pct == null ? null : Number(before.commission_pct) };
  });
  if (out.err === 'not_found') return res.status(404).json({ error: 'not_found' });
  if (out.err) return badRequest(res, out.detail, ['commissionPct']);
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'membership.commission',
    entityType: 'membership', entityId: out.row.id, metadata: { from: out.previous, to: v },
  });
  res.json({ id: out.row.id, commissionPct: out.row.commission_pct == null ? null : Number(out.row.commission_pct) });
}));

// A caller may only hand out a role whose permissions they hold themselves,
// so an admin cannot make anyone (including a colleague) an owner.
async function roleWithinCallerRights(c, req, roleName) {
  const role = (await c.query(
    'SELECT permissions FROM roles WHERE workspace_id=$1 AND name=$2', [wid(req), roleName])).rows[0];
  if (!role) return { err: 'unknown_role' };
  const held = req.membership.permissions;
  const unheld = role.permissions.filter((p) => !(held ? held.has(p) : false));
  if (unheld.length) return { err: 'cannot_grant_unheld_permission', detail: unheld.join(',') };
  if (roleName === 'owner' && req.membership.role !== 'owner') return { err: 'cannot_grant_unheld_permission', detail: 'owner' };
  return {};
}

async function isLastOwner(c, workspaceId, membershipId) {
  const { rows } = await c.query(
    `SELECT count(*)::int AS owners FROM memberships
      WHERE workspace_id=$1 AND role='owner' AND status='active' AND id <> $2`, [workspaceId, membershipId]);
  return rows[0].owners === 0;
}

// PATCH /:membershipId/role  { role }
router.patch('/:membershipId/role', requirePermission('team.manage'), asyncHandler(async (req, res) => {
  const role = String((req.body || {}).role || '');
  if (!role) return badRequest(res, 'role is required', ['role']);
  if (req.params.membershipId === req.membership.id) return res.status(403).json({ error: 'cannot_edit_own_role' });

  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    const target = (await c.query(
      "SELECT id, user_id, role FROM memberships WHERE id=$1 AND workspace_id=$2 AND status='active'",
      [req.params.membershipId, wid(req)])).rows[0];
    if (!target) return { err: 'not_found', code: 404 };
    const rights = await roleWithinCallerRights(c, req, role);
    if (rights.err) return { err: rights.err, detail: rights.detail, code: rights.err === 'unknown_role' ? 400 : 403 };
    if (target.role === 'owner' && role !== 'owner' && await isLastOwner(c, wid(req), target.id)) {
      return { err: 'last_owner', code: 409 };
    }
    const row = (await c.query(
      'UPDATE memberships SET role=$1 WHERE id=$2 RETURNING id, role', [role, target.id])).rows[0];
    return { row, target };
  });
  if (out.err) return res.status(out.code).json({ error: out.err, detail: out.detail });

  await revokeUserSessions(out.target.user_id);
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'membership.role',
    entityType: 'membership', entityId: out.row.id, metadata: { from: out.target.role, to: role },
  });
  res.json({ id: out.row.id, role: out.row.role });
}));

// DELETE /:membershipId — revoke a member's seat. Their sessions end now.
router.delete('/:membershipId', requirePermission('team.manage'), asyncHandler(async (req, res) => {
  if (req.params.membershipId === req.membership.id) return res.status(403).json({ error: 'cannot_remove_self' });

  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    const target = (await c.query(
      "SELECT id, user_id, role FROM memberships WHERE id=$1 AND workspace_id=$2 AND status='active'",
      [req.params.membershipId, wid(req)])).rows[0];
    if (!target) return { err: 'not_found', code: 404 };
    if (target.role === 'owner' && await isLastOwner(c, wid(req), target.id)) return { err: 'last_owner', code: 409 };
    await c.query("UPDATE memberships SET status='archived' WHERE id=$1", [target.id]);
    return { target };
  });
  if (out.err) return res.status(out.code).json({ error: out.err });

  await revokeUserSessions(out.target.user_id);
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'membership.remove',
    entityType: 'membership', entityId: out.target.id, metadata: { role: out.target.role },
  });
  res.status(204).end();
}));

module.exports = router;
