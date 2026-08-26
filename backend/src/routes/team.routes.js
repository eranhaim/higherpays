'use strict';
// Who may sign into this workspace. Agents and accounts are created on their
// own routes (the profile and the login are one operation); admins and
// analysts arrive through invites. This route lists everyone and controls
// their access.
const express = require('express');
const { query, withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { revokeUserSessions } = require('../auth/sessions');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

// GET / — everyone with access, and the profile behind the role when there is one.
router.get('/', requirePermission('team.view'), asyncHandler(async (req, res) => {
  const rows = (await query(
    `SELECT wu.user_id, wu.role, wu.status, wu.created_at,
            u.full_name AS name, u.email,
            ag.id AS agent_id, ac.id AS account_id, ac.name AS account_name
       FROM workspace_users wu
       JOIN users u ON u.id = wu.user_id
       LEFT JOIN agents ag ON ag.workspace_id = wu.workspace_id AND ag.user_id = wu.user_id
       LEFT JOIN accounts ac ON ac.workspace_id = wu.workspace_id AND ac.user_id = wu.user_id
      WHERE wu.workspace_id = $1
      ORDER BY wu.role, u.full_name`, [wid(req)])).rows;
  res.json({
    members: rows.map((r) => ({
      userId: r.user_id, name: r.name, email: r.email, role: r.role, status: r.status,
      agentId: r.agent_id, accountId: r.account_id, accountName: r.account_name,
      isSelf: r.user_id === uid(req), joinedAt: r.created_at,
    })),
  });
}));

async function isLastAdmin(c, workspaceId, userId) {
  const { rows } = await c.query(
    `SELECT count(*)::int AS admins FROM workspace_users
      WHERE workspace_id=$1 AND role='workspace_admin' AND status='active' AND user_id <> $2`, [workspaceId, userId]);
  return rows[0].admins === 0;
}

// PATCH /:userId/status  { status: 'active' | 'suspended' }
// Suspending keeps the agent or account record, so past payments keep their
// attribution; it only stops the sign-in.
router.patch('/:userId/status', requirePermission('team.manage'), asyncHandler(async (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'validation_failed', detail: 'status must be active or suspended', fields: ['status'] });
  if (req.params.userId === uid(req)) return res.status(403).json({ error: 'cannot_edit_self' });

  const out = await withTransaction(async (c) => {
    const target = (await c.query(
      'SELECT role, status FROM workspace_users WHERE workspace_id=$1 AND user_id=$2', [wid(req), req.params.userId])).rows[0];
    if (!target) return { err: 'not_found', code: 404 };
    if (status === 'suspended' && target.role === 'workspace_admin' && await isLastAdmin(c, wid(req), req.params.userId)) {
      return { err: 'last_admin', code: 409 };
    }
    await c.query('UPDATE workspace_users SET status=$3 WHERE workspace_id=$1 AND user_id=$2', [wid(req), req.params.userId, status]);
    return { target };
  });
  if (out.err) return res.status(out.code).json({ error: out.err });

  if (status === 'suspended') await revokeUserSessions(req.params.userId);
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'team.status',
    entityType: 'user', entityId: req.params.userId, metadata: { from: out.target.status, to: status },
  });
  res.json({ userId: req.params.userId, status });
}));

// DELETE /:userId — remove access entirely. Refused while an agent or account
// record still hangs off it: suspend instead, so the ledger keeps its names.
router.delete('/:userId', requirePermission('team.manage'), asyncHandler(async (req, res) => {
  if (req.params.userId === uid(req)) return res.status(403).json({ error: 'cannot_remove_self' });
  const out = await withTransaction(async (c) => {
    const target = (await c.query(
      'SELECT role FROM workspace_users WHERE workspace_id=$1 AND user_id=$2', [wid(req), req.params.userId])).rows[0];
    if (!target) return { err: 'not_found', code: 404 };
    if (target.role === 'workspace_admin' && await isLastAdmin(c, wid(req), req.params.userId)) return { err: 'last_admin', code: 409 };
    const profile = (await c.query(
      `SELECT 1 FROM agents WHERE workspace_id=$1 AND user_id=$2
       UNION ALL SELECT 1 FROM accounts WHERE workspace_id=$1 AND user_id=$2 LIMIT 1`, [wid(req), req.params.userId])).rows[0];
    if (profile) return { err: 'has_profile', code: 409 };
    await c.query('DELETE FROM workspace_users WHERE workspace_id=$1 AND user_id=$2', [wid(req), req.params.userId]);
    return { target };
  });
  if (out.err) return res.status(out.code).json({ error: out.err });

  await revokeUserSessions(req.params.userId);
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'team.remove',
    entityType: 'user', entityId: req.params.userId, metadata: { role: out.target.role },
  });
  res.status(204).end();
}));

module.exports = router;
