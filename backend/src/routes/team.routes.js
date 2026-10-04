'use strict';
// Who may sign into this workspace. Agents and accounts are created on their
// own routes (the profile and the login are one operation); plain members are
// created directly here. This route lists everyone and controls their access.
const express = require('express');
const { query, withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { revokeUserSessions } = require('../auth/sessions');
const { hashPassword, validatePasswordStrength } = require('../auth/passwords');
const { PERMISSIONS, ROLE_PERMISSIONS, validatePermissions } = require('../auth/permissions');
const { isStr, badRequest } = require('../util/validate');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

const PLAIN_MEMBER_TYPES = new Set(['workspace_admin', 'member']);

function canGrantAllPermissions(req) {
  return req.access.role === 'workspace_owner' || req.access.role === 'workspace_admin';
}

function validateMemberPermissions(req, permissions) {
  return validatePermissions(permissions, canGrantAllPermissions(req) ? PERMISSIONS : [...req.access.permissions]);
}

function roleName(role, labels) {
  if (role === 'agent') return labels.agent_label;
  if (role === 'account_owner') return `${labels.account_label} owner`;
  if (role === 'workspace_owner') return 'Owner';
  if (role === 'workspace_admin') return 'Admin';
  return 'Member';
}

function dateRange(query) {
  const valid = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const from = query.from == null ? null : valid(query.from) ? query.from : false;
  const to = query.to == null ? null : valid(query.to) ? query.to : false;
  if (from === false || to === false || (from && to && from > to)) return null;
  return { from, to };
}

// POST / — create a login and active workspace seat without email delivery.
router.post('/', requirePermission('team.manage'), asyncHandler(async (req, res) => {
  const { email, password, fullName, role = 'member', permissions } = req.body || {};
  if (!isStr(email, 100) || !email.includes('@')) return badRequest(res, 'a valid email is required', ['email']);
  if (!isStr(password, 200) || validatePasswordStrength(password)) return badRequest(res, 'password is not strong enough', ['password']);
  if (!PLAIN_MEMBER_TYPES.has(role)) {
    return badRequest(res, 'role is not available for direct member creation', ['role']);
  }
  const seatPermissions = permissions ?? [...(ROLE_PERMISSIONS[role] || [])];
  const permissionError = validateMemberPermissions(req, seatPermissions);
  if (permissionError) return res.status(400).json({ error: permissionError });

  const out = await withTransaction(async (client) => {
    const existing = (await client.query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
    if (existing) return { error: 'user_exists', status: 409 };

    const user = (await client.query(
      `INSERT INTO users (email, full_name, password_hash)
       VALUES ($1,$2,$3) RETURNING id`,
      [email, isStr(fullName, 120) ? fullName.trim() : email, await hashPassword(password)]
    )).rows[0];
    await client.query(
      'INSERT INTO workspace_users (workspace_id, user_id, role, permissions) VALUES ($1,$2,$3,$4)',
      [wid(req), user.id, role, seatPermissions]
    );
    return { userId: user.id, role, permissions: seatPermissions };
  });

  if (out.error) return res.status(out.status).json({ error: out.error });
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'team.member.create',
    entityType: 'user', entityId: out.userId, metadata: { email, role: out.role, permissions: out.permissions },
  });
  res.status(201).json(out);
}));

// GET / — everyone with access, and the profile behind the role when there is one.
router.get('/', requirePermission('team.view'), asyncHandler(async (req, res) => {
  const range = dateRange(req.query);
  if (!range) return res.status(400).json({ error: 'invalid_date_range' });
  const rows = (await query(
    `WITH customer_paid AS (
       SELECT p.agent_id,
              p.account_id,
              SUM(
                CASE t.type
                  WHEN 'payment' THEN t.gross + t.surcharge
                  WHEN 'refund' THEN -(t.gross + COALESCE(sale.surcharge, 0))
                  WHEN 'chargeback' THEN -(t.gross + COALESCE(sale.surcharge, 0))
                  ELSE 0
                END
              ) AS total
         FROM payments p
         JOIN transactions t ON t.payment_id = p.id
         LEFT JOIN transactions sale ON sale.payment_id = p.id AND sale.type = 'payment'
        WHERE p.workspace_id = $1
          AND p.archived_at IS NULL
          AND t.type IN ('payment', 'refund', 'chargeback')
          AND t.status IN ('approved', 'refunded', 'charged_back')
          AND ($2::date IS NULL OR t.occurred_at >= $2::date)
          AND ($3::date IS NULL OR t.occurred_at < ($3::date + interval '1 day'))
        GROUP BY p.agent_id, p.account_id
     )
     SELECT wu.user_id, wu.role, wu.permissions, wu.status, wu.created_at,
            u.full_name AS name, u.email,
            w.account_label, w.agent_label,
            ag.id AS agent_id, ac.id AS account_id, ac.name AS account_name,
            ac.status AS account_status,
            CASE
              WHEN ag.id IS NOT NULL THEN COALESCE(agent_sales.total, 0)
              WHEN ac.id IS NOT NULL THEN COALESCE(account_sales.total, 0)
              ELSE NULL
            END AS total_customer_paid
       FROM workspace_users wu
       JOIN users u ON u.id = wu.user_id
       JOIN workspaces w ON w.id = wu.workspace_id
       LEFT JOIN agents ag ON ag.workspace_id = wu.workspace_id AND ag.user_id = wu.user_id
       LEFT JOIN accounts ac ON ac.workspace_id = wu.workspace_id AND ac.user_id = wu.user_id
       LEFT JOIN customer_paid agent_sales ON agent_sales.agent_id = ag.id
       LEFT JOIN customer_paid account_sales ON account_sales.account_id = ac.id
      WHERE wu.workspace_id = $1
      ORDER BY wu.role, u.full_name`, [wid(req), range.from, range.to])).rows;
  res.json({
    members: rows.map((r) => ({
      userId: r.user_id, name: r.name, email: r.email, role: r.role,
      roleName: roleName(r.role, r), permissions: r.permissions || [], status: r.status,
      agentId: r.agent_id, accountId: r.account_id, accountName: r.account_name, accountStatus: r.account_status,
      totalCustomerPaid: r.total_customer_paid == null ? null : Number(r.total_customer_paid),
      isSelf: r.user_id === uid(req), joinedAt: r.created_at,
    })),
  });
}));

async function targetForRoleChange(client, workspaceId, userId) {
  return (await client.query(
    `SELECT wu.role, wu.status, wu.permissions, u.full_name, u.email, u.is_platform_admin,
            EXISTS (SELECT 1 FROM agents WHERE workspace_id=wu.workspace_id AND user_id=wu.user_id) AS has_agent,
            EXISTS (SELECT 1 FROM accounts WHERE workspace_id=wu.workspace_id AND user_id=wu.user_id) AS has_account
       FROM workspace_users wu
       JOIN users u ON u.id=wu.user_id
      WHERE wu.workspace_id=$1 AND wu.user_id=$2
      FOR UPDATE OF wu`,
    [workspaceId, userId])).rows[0];
}

// PATCH /:userId — edits one seat and its global login identity. The password
// value is hashed inside the transaction and is never logged or returned.
router.patch('/:userId', requirePermission('team.manage'), asyncHandler(async (req, res) => {
  if (req.params.userId === uid(req)) return res.status(403).json({ error: 'cannot_edit_self' });
  const body = req.body || {};
  const hasName = Object.hasOwn(body, 'fullName');
  const hasEmail = Object.hasOwn(body, 'email');
  const hasRole = Object.hasOwn(body, 'role');
  const hasPermissions = Object.hasOwn(body, 'permissions');
  const hasPassword = Object.hasOwn(body, 'password');
  if (!hasName && !hasEmail && !hasRole && !hasPermissions && !hasPassword) {
    return res.status(400).json({ error: 'no_changes' });
  }
  if (hasName && !isStr(body.fullName, 120)) return badRequest(res, 'fullName is required', ['fullName']);
  if (hasEmail && (!isStr(body.email, 100) || !body.email.includes('@'))) return badRequest(res, 'a valid email is required', ['email']);
  if (hasPassword) {
    if (req.user.actorId) return res.status(403).json({ error: 'impersonation_password_forbidden' });
    if (body.password !== body.passwordConfirm) return badRequest(res, 'password confirmation does not match', ['passwordConfirm']);
    if (validatePasswordStrength(body.password)) return badRequest(res, 'password is not strong enough', ['password']);
    const editor = (await query('SELECT two_factor_enabled FROM users WHERE id=$1', [uid(req)])).rows[0];
    if (editor?.two_factor_enabled && !req.user.twoFactorAuthenticated) {
      return res.status(403).json({ error: 'two_factor_authentication_required' });
    }
  }
  if (hasPermissions) {
    const permissionError = validateMemberPermissions(req, body.permissions);
    if (permissionError) return res.status(400).json({ error: permissionError });
  }

  const out = await withTransaction(async (client) => {
    const target = await targetForRoleChange(client, wid(req), req.params.userId);
    if (!target) return { error: 'not_found', status: 404 };
    if (target.role === 'workspace_owner') return { error: 'owner_role_fixed', status: 409 };
    if (target.is_platform_admin) return { error: 'platform_admin_role_fixed', status: 409 };

    let nextRole = target.role;
    if (hasRole) {
      if (!PLAIN_MEMBER_TYPES.has(body.role)) return { error: 'role_not_available', status: 400 };
      if (target.has_agent || target.has_account) return { error: 'profile_role_fixed', status: 409 };
      nextRole = body.role;
    }
    const nextPermissions = hasPermissions
      ? body.permissions
      : hasRole && nextRole === 'workspace_admin'
        ? [...ROLE_PERMISSIONS.workspace_admin]
        : target.permissions;
    const permissionError = validateMemberPermissions(req, nextPermissions);
    if (permissionError) return { error: permissionError, status: 400 };

    if (hasEmail) {
      const duplicate = (await client.query(
        'SELECT id FROM users WHERE email=$1 AND id<>$2', [body.email.trim(), req.params.userId])).rows[0];
      if (duplicate) return { error: 'email_in_use', status: 409 };
    }
    await client.query(
      `UPDATE users
          SET full_name = CASE WHEN $2::boolean THEN $3 ELSE full_name END,
              email = CASE WHEN $4::boolean THEN $5 ELSE email END,
              password_hash = CASE WHEN $6::boolean THEN $7 ELSE password_hash END
        WHERE id=$1`,
      [req.params.userId, hasName, hasName ? body.fullName.trim() : null,
        hasEmail, hasEmail ? body.email.trim() : null, hasPassword,
        hasPassword ? await hashPassword(body.password) : null]);
    await client.query(
      'UPDATE workspace_users SET role=$3, permissions=$4 WHERE workspace_id=$1 AND user_id=$2',
      [wid(req), req.params.userId, nextRole, nextPermissions]);
    return {
      before: { name: target.full_name, email: target.email, role: target.role, permissions: target.permissions },
      after: {
        name: hasName ? body.fullName.trim() : target.full_name,
        email: hasEmail ? body.email.trim() : target.email,
        role: nextRole,
        permissions: nextPermissions,
      },
      passwordSet: hasPassword,
    };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  if (out.passwordSet) await revokeUserSessions(req.params.userId);
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'team.member.update',
    entityType: 'user', entityId: req.params.userId,
    metadata: { before: out.before, after: out.after, passwordSet: out.passwordSet },
    ip: req.ip || null,
  });
  res.json({ userId: req.params.userId, ...out.after, passwordSet: out.passwordSet });
}));

router.post('/owner-transfer', requirePermission('team.manage'), asyncHandler(async (req, res) => {
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
      `UPDATE workspace_users SET role='workspace_admin', permissions=$3
        WHERE workspace_id=$1 AND user_id=$2`,
      [wid(req), uid(req), [...ROLE_PERMISSIONS.workspace_admin]]);
    await client.query(
      `UPDATE workspace_users SET role='workspace_owner', permissions=$3
        WHERE workspace_id=$1 AND user_id=$2`,
      [wid(req), targetUserId, [...ROLE_PERMISSIONS.workspace_owner]]);
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
