'use strict';
// Who may sign into this workspace. Agents and accounts are created on their
// own routes (the profile and the login are one operation); plain members are
// created directly here. This route lists everyone and controls their access.
const express = require('express');
const { query, withTransaction } = require('../db');
const { requirePermission, requireRoleManager } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { revokeUserSessions } = require('../auth/sessions');
const { hashPassword } = require('../auth/passwords');
const { PROFILE_ROLES, ensureWorkspaceRoles } = require('../services/workspaceRoles');
const { isStr, badRequest } = require('../util/validate');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

// POST / — create a login and active workspace seat without email delivery.
router.post('/', requireRoleManager, asyncHandler(async (req, res) => {
  const { email, password, fullName, role } = req.body || {};
  if (!isStr(email, 100) || !email.includes('@')) return badRequest(res, 'a valid email is required', ['email']);
  if (!isStr(password, 200) || password.length < 8) return badRequest(res, 'password must be at least 8 characters', ['password']);
  if (!isStr(role, 100) || PROFILE_ROLES.has(role) || role === 'workspace_owner') {
    return badRequest(res, 'role is not available for direct member creation', ['role']);
  }

  const out = await withTransaction(async (client) => {
    await ensureWorkspaceRoles(client, wid(req));
    const roleRow = (await client.query(
      'SELECT key, permissions FROM workspace_roles WHERE workspace_id=$1 AND key=$2',
      [wid(req), role])).rows[0];
    if (!roleRow) return { error: 'unknown_role', status: 400 };
    if (roleRow.permissions.some((permission) => !req.canGrantAllRolePermissions && !req.access.permissions.has(permission))) {
      return { error: 'role_not_assignable', status: 403 };
    }

    const existing = (await client.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
    if (existing) return { error: 'user_exists', status: 409 };

    const user = (await client.query(
      `INSERT INTO users (email, full_name, password_hash)
       VALUES ($1,$2,$3) RETURNING id`,
      [email, isStr(fullName, 120) ? fullName.trim() : email, await hashPassword(password)]
    )).rows[0];
    await client.query(
      'INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,$3)',
      [wid(req), user.id, role]
    );
    return { userId: user.id, role };
  });

  if (out.error) return res.status(out.status).json({ error: out.error });
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'team.member.create',
    entityType: 'user', entityId: out.userId, metadata: { email, role: out.role },
  });
  res.status(201).json(out);
}));

// GET / — everyone with access, and the profile behind the role when there is one.
router.get('/', requirePermission('team.view'), asyncHandler(async (req, res) => {
  const rows = (await query(
    `SELECT wu.user_id, wu.role, wr.name AS role_name, wu.status, wu.created_at,
            u.full_name AS name, u.email,
            ag.id AS agent_id, ac.id AS account_id, ac.name AS account_name,
            ac.status AS account_status
       FROM workspace_users wu
       JOIN users u ON u.id = wu.user_id
       JOIN workspace_roles wr ON wr.workspace_id=wu.workspace_id AND wr.key=wu.role
       LEFT JOIN agents ag ON ag.workspace_id = wu.workspace_id AND ag.user_id = wu.user_id
       LEFT JOIN accounts ac ON ac.workspace_id = wu.workspace_id AND ac.user_id = wu.user_id
      WHERE wu.workspace_id = $1
      ORDER BY wu.role, u.full_name`, [wid(req)])).rows;
  res.json({
    members: rows.map((r) => ({
      userId: r.user_id, name: r.name, email: r.email, role: r.role, roleName: r.role_name, status: r.status,
      agentId: r.agent_id, accountId: r.account_id, accountName: r.account_name, accountStatus: r.account_status,
      isSelf: r.user_id === uid(req), joinedAt: r.created_at,
    })),
  });
}));

async function targetForRoleChange(client, workspaceId, userId) {
  return (await client.query(
    `SELECT wu.role, wu.status, u.is_platform_admin,
            EXISTS (SELECT 1 FROM agents WHERE workspace_id=wu.workspace_id AND user_id=wu.user_id) AS has_agent,
            EXISTS (SELECT 1 FROM accounts WHERE workspace_id=wu.workspace_id AND user_id=wu.user_id) AS has_account
       FROM workspace_users wu
       JOIN users u ON u.id=wu.user_id
      WHERE wu.workspace_id=$1 AND wu.user_id=$2
      FOR UPDATE OF wu`,
    [workspaceId, userId])).rows[0];
}

router.patch('/:userId/role', requireRoleManager, asyncHandler(async (req, res) => {
  const nextRole = String(req.body?.role || '');
  if (!nextRole) return res.status(400).json({ error: 'role_required' });
  if (nextRole === 'workspace_owner') return res.status(409).json({ error: 'use_owner_transfer' });
  if (req.params.userId === uid(req)) return res.status(403).json({ error: 'cannot_edit_self' });

  const out = await withTransaction(async (client) => {
    await ensureWorkspaceRoles(client, wid(req));
    const target = await targetForRoleChange(client, wid(req), req.params.userId);
    if (!target) return { error: 'not_found', status: 404 };
    if (target.role === 'workspace_owner') return { error: 'owner_role_fixed', status: 409 };
    if (target.is_platform_admin) return { error: 'platform_admin_role_fixed', status: 409 };
    const role = (await client.query(
      'SELECT key, permissions FROM workspace_roles WHERE workspace_id=$1 AND key=$2',
      [wid(req), nextRole])).rows[0];
    if (!role) return { error: 'unknown_role', status: 400 };
    if (!req.canGrantAllRolePermissions && role.permissions.some((permission) => !req.access.permissions.has(permission))) {
      return { error: 'role_not_assignable', status: 403 };
    }
    if (target.has_agent && nextRole !== 'agent') return { error: 'profile_role_locked', status: 409 };
    if (target.has_account && nextRole !== 'account_owner') return { error: 'profile_role_locked', status: 409 };
    if (!target.has_agent && !target.has_account && PROFILE_ROLES.has(nextRole)) {
      return { error: 'profile_required', status: 409 };
    }
    await client.query(
      'UPDATE workspace_users SET role=$3 WHERE workspace_id=$1 AND user_id=$2',
      [wid(req), req.params.userId, nextRole]);
    return { from: target.role, role: nextRole };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'team.role',
    entityType: 'user', entityId: req.params.userId, metadata: { from: out.from, to: out.role },
  });
  res.json({ userId: req.params.userId, role: out.role });
}));

router.post('/owner-transfer', requirePermission('roles.manage'), asyncHandler(async (req, res) => {
  const targetUserId = String(req.body?.userId || '');
  if (req.access.role !== 'workspace_owner') return res.status(403).json({ error: 'owner_only' });
  if (!targetUserId || targetUserId === uid(req)) return res.status(400).json({ error: 'target_invalid' });

  const out = await withTransaction(async (client) => {
    const target = await targetForRoleChange(client, wid(req), targetUserId);
    if (!target) return { error: 'not_found', status: 404 };
    if (target.status !== 'active') return { error: 'target_suspended', status: 409 };
    if (target.is_platform_admin) return { error: 'platform_admin_cannot_own', status: 409 };
    if (target.has_agent || target.has_account) return { error: 'profile_role_locked', status: 409 };
    const owner = (await client.query(
      `SELECT user_id FROM workspace_users
        WHERE workspace_id=$1 AND role='workspace_owner'
        FOR UPDATE`,
      [wid(req)])).rows[0];
    if (!owner || owner.user_id !== uid(req)) return { error: 'owner_changed', status: 409 };
    await client.query(
      `UPDATE workspace_users SET role='workspace_admin'
        WHERE workspace_id=$1 AND user_id=$2`,
      [wid(req), uid(req)]);
    await client.query(
      `UPDATE workspace_users SET role='workspace_owner'
        WHERE workspace_id=$1 AND user_id=$2`,
      [wid(req), targetUserId]);
    return { previousOwnerId: uid(req) };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'team.owner_transfer',
    entityType: 'user', entityId: targetUserId, metadata: { previousOwnerId: out.previousOwnerId },
  });
  res.json({ ownerUserId: targetUserId });
}));

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
    if (target.role === 'workspace_owner') return { err: 'transfer_owner', code: 409 };
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

// DELETE /:userId — mark a plain seat removed. The row stays as access history.
// Profile-backed seats are suspended instead, so their business record remains
// available to the ledger.
router.delete('/:userId', requirePermission('team.manage'), asyncHandler(async (req, res) => {
  if (req.params.userId === uid(req)) return res.status(403).json({ error: 'cannot_remove_self' });
  const out = await withTransaction(async (c) => {
    const target = (await c.query(
      'SELECT role, status FROM workspace_users WHERE workspace_id=$1 AND user_id=$2', [wid(req), req.params.userId])).rows[0];
    if (!target) return { err: 'not_found', code: 404 };
    if (target.role === 'workspace_owner') return { err: 'transfer_owner', code: 409 };
    const profile = (await c.query(
      `SELECT 1 FROM agents WHERE workspace_id=$1 AND user_id=$2
       UNION ALL SELECT 1 FROM accounts WHERE workspace_id=$1 AND user_id=$2 LIMIT 1`, [wid(req), req.params.userId])).rows[0];
    if (profile) return { err: 'has_profile', code: 409 };
    if (target.status === 'removed') return { err: 'not_found', code: 404 };
    await c.query(
      "UPDATE workspace_users SET status='removed' WHERE workspace_id=$1 AND user_id=$2",
      [wid(req), req.params.userId]);
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
