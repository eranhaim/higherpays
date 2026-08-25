'use strict';
const express = require('express');
const crypto = require('crypto');
const { withWorkspace, withPlatformAdmin } = require('../db');
const { requireAuth, requireWorkspace, requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { hashPassword } = require('../auth/passwords');
const { isStr, badRequest } = require('../util/validate');
const { sendEmail } = require('../util/email');
const { roleWithinCallerRights } = require('../auth/roleGrants');

const { wid, uid } = require('../lib/scope');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ---- workspace-scoped: create + list invites (mounted under /workspaces/:id) ----
const wsRouter = express.Router({ mergeParams: true });

// POST /workspaces/:wid/invites  { email, role, accountId? }
// The invited role runs through the same grant check as a role change: an
// invite that could hand out a role the caller does not hold would be a way
// around PATCH /memberships/:id/role.
wsRouter.post('/', requireAuth, requireWorkspace, requirePermission('team.manage'), asyncHandler(async (req, res) => {
  const { email, role, accountId } = req.body || {};
  if (!isStr(email, 100) || !isStr(role, 40)) return badRequest(res, 'email and role are required', ['email', 'role']);
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 7 * 86400 * 1000);
  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    const rights = await roleWithinCallerRights(c, req, role);
    if (rights.err) return { err: rights.err, detail: rights.detail };
    const row = (await c.query(
      `INSERT INTO invites (workspace_id, email, role, account_id, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, email, role, expires_at`,
      [wid(req), email, role, accountId || null, hashToken(token), uid(req), expires])).rows[0];
    return { row };
  });
  if (out.err) return res.status(out.err === 'unknown_role' ? 400 : 403).json({ error: out.err, detail: out.detail });
  const link = `https://app.higherpays.com/accept-invite?token=${token}`;
  await sendEmail({ to: email, subject: `You're invited to HigherPays (${role})`, body: `Set up your login: ${link}` });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'invite.create', metadata: { email, role } });
  // The token is a bearer credential for a workspace seat and is NOT returned:
  // it only ever reaches the invited address. Tests read it from the email stub.
  res.status(201).json(out.row);
}));

// GET /workspaces/:wid/invites — pending invites
wsRouter.get('/', requireAuth, requireWorkspace, requirePermission('team.view'), asyncHandler(async (req, res) => {
  const rows = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `SELECT id, email, role, expires_at, accepted_at FROM invites WHERE workspace_id=$1 ORDER BY created_at DESC`, [wid(req)])).rows);
  res.json({ invites: rows });
}));

// DELETE /workspaces/:wid/invites/:id — withdraw an invite that has not been
// used. The row is removed rather than flagged: the token is the credential, so
// the only way to make it useless is for it to stop resolving. An already
// accepted invite is left alone — the seat it created is revoked through
// DELETE /memberships/:id, not here.
wsRouter.delete('/:id', requireAuth, requireWorkspace, requirePermission('team.manage'), asyncHandler(async (req, res) => {
  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    const inv = (await c.query(
      'SELECT id, email, role, accepted_at FROM invites WHERE id=$1 AND workspace_id=$2',
      [req.params.id, wid(req)])).rows[0];
    if (!inv) return { err: 'not_found', code: 404 };
    if (inv.accepted_at) return { err: 'invite_already_accepted', code: 409 };
    await c.query('DELETE FROM invites WHERE id=$1 AND workspace_id=$2', [req.params.id, wid(req)]);
    return { inv };
  });
  if (out.err) return res.status(out.code).json({ error: out.err });
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'invite.revoke',
    metadata: { email: out.inv.email, role: out.inv.role },
  });
  res.status(204).end();
}));

// ---- public: validate + accept an invite (no auth; keyed by secret token) ----
const publicRouter = express.Router();

// GET /invites/:token — check validity (used by the accept page)
publicRouter.get('/:token', asyncHandler(async (req, res) => {
  const inv = await withPlatformAdmin(null, async (c) => (await c.query(
    `SELECT i.email, i.role, w.name AS workspace, i.expires_at, i.accepted_at
     FROM invites i JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.token_hash=$1`, [hashToken(req.params.token)])).rows[0]);
  if (!inv || inv.accepted_at || new Date(inv.expires_at) < new Date()) return res.status(404).json({ error: 'invalid_invite' });
  res.json({ email: inv.email, role: inv.role, workspace: inv.workspace });
}));

// POST /invites/:token/accept  { password, fullName }
// Provisions the login (new user + membership with the invited role), or attaches
// the role to an existing user. Runs in an elevated context (trusted server op).
publicRouter.post('/:token/accept', asyncHandler(async (req, res) => {
  const { password, fullName } = req.body || {};

  const out = await withPlatformAdmin(null, async (c) => {
    const inv = (await c.query(
      `SELECT * FROM invites WHERE token_hash=$1`, [hashToken(req.params.token)])).rows[0];
    if (!inv || inv.accepted_at || new Date(inv.expires_at) < new Date()) return { err: 'invalid_invite' };

    let user = (await c.query('SELECT id, email, full_name FROM users WHERE email=$1', [inv.email])).rows[0];
    const existed = !!user;
    if (!user) {
      // brand-new person: they must set a password to create the login
      if (!password || String(password).length < 8) return { err: 'weak_password' };
      const pw = await hashPassword(password);
      user = (await c.query(
        'INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id, email, full_name',
        [inv.email, pw, fullName || inv.email])).rows[0];
    }
    // An invite PROVISIONS a seat; it never re-roles someone who already has one.
    // Role changes go through PATCH /memberships/:id/role, which carries
    // cannot_edit_own_role, isLastOwner and revokeUserSessions. Without the
    // status guard below, anyone holding an invite token could rewrite an active
    // member's role — including demoting the last owner.
    const seat = await c.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role=EXCLUDED.role, status='active'
         WHERE memberships.status <> 'active'`,
      [inv.workspace_id, user.id, inv.role]);
    // The invite is consumed either way, so a stale token cannot be replayed.
    await c.query('UPDATE invites SET accepted_at=now() WHERE id=$1', [inv.id]);
    if (seat.rowCount === 0) return { err: 'already_a_member' };
    return { user, workspaceId: inv.workspace_id, role: inv.role, existing: !!existed };
  });
  if (out.err === 'weak_password') return badRequest(res, 'weak_password', ['password']);
  if (out.err === 'already_a_member') return res.status(409).json({ error: 'already_a_member' });
  if (out.err) return res.status(404).json({ error: out.err });
  await audit({ workspaceId: out.workspaceId, actorUserId: out.user.id, action: 'invite.accept', metadata: { role: out.role } });
  res.status(201).json({ ok: true, userId: out.user.id, workspaceId: out.workspaceId, role: out.role, existingUser: !!out.existing });
}));

module.exports = { wsRouter, publicRouter };
