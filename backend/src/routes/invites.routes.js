'use strict';
// Invites bring in the roles that have no profile of their own: admins and
// analysts. An agent or an account is created directly, login included, on
// its own route.
const express = require('express');
const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const { requireAuth, requireWorkspace, requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { hashPassword } = require('../auth/passwords');
const { isStr, badRequest } = require('../util/validate');
const { sendEmail } = require('../util/email');

const { wid, uid } = require('../lib/scope');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const INVITABLE_ROLES = ['workspace_admin', 'analyst'];

const wsRouter = express.Router({ mergeParams: true });

// POST /workspaces/:wid/invites  { email, role }
wsRouter.post('/', requireAuth, requireWorkspace, requirePermission('team.manage'), asyncHandler(async (req, res) => {
  const { email, role } = req.body || {};
  if (!isStr(email, 100) || !email.includes('@')) return badRequest(res, 'a valid email is required', ['email']);
  if (!INVITABLE_ROLES.includes(role)) return badRequest(res, `role must be one of ${INVITABLE_ROLES.join(', ')}`, ['role']);
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 7 * 86400 * 1000);
  const row = (await query(
    `INSERT INTO invites (workspace_id, email, role, token_hash, invited_by_user_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, role, expires_at, accepted_at`,
    [wid(req), email, role, hashToken(token), uid(req), expires])).rows[0];
  const link = `https://app.higherpays.com/accept-invite?token=${token}`;
  await sendEmail({ to: email, subject: `You're invited to HigherPays (${role})`, body: `Set up your login: ${link}` });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'invite.create', metadata: { email, role } });
  // The token is a bearer credential for a seat and is NOT returned: it only
  // ever reaches the invited address. Tests read it from the email stub.
  res.status(201).json(row);
}));

// GET /workspaces/:wid/invites
wsRouter.get('/', requireAuth, requireWorkspace, requirePermission('team.view'), asyncHandler(async (req, res) => {
  const rows = (await query(
    'SELECT id, email, role, expires_at, accepted_at FROM invites WHERE workspace_id=$1 ORDER BY created_at DESC', [wid(req)])).rows;
  res.json({ invites: rows });
}));

// DELETE /workspaces/:wid/invites/:id — withdraw an unused invite. The row is
// removed rather than flagged: the token is the credential, so the only way to
// make it useless is for it to stop resolving.
wsRouter.delete('/:id', requireAuth, requireWorkspace, requirePermission('team.manage'), asyncHandler(async (req, res) => {
  const inv = (await query(
    'SELECT id, email, role, accepted_at FROM invites WHERE id=$1 AND workspace_id=$2', [req.params.id, wid(req)])).rows[0];
  if (!inv) return res.status(404).json({ error: 'not_found' });
  if (inv.accepted_at) return res.status(409).json({ error: 'invite_already_accepted' });
  await query('DELETE FROM invites WHERE id=$1', [inv.id]);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'invite.revoke', metadata: { email: inv.email, role: inv.role } });
  res.status(204).end();
}));

// ---- public: validate + accept an invite (no auth; keyed by the token) ----
const publicRouter = express.Router();

publicRouter.get('/:token', asyncHandler(async (req, res) => {
  const inv = (await query(
    `SELECT i.email, i.role, w.name AS workspace, i.expires_at, i.accepted_at
       FROM invites i JOIN workspaces w ON w.id = i.workspace_id
      WHERE i.token_hash=$1`, [hashToken(req.params.token)])).rows[0];
  if (!inv || inv.accepted_at || new Date(inv.expires_at) < new Date()) return res.status(404).json({ error: 'invalid_invite' });
  res.json({ email: inv.email, role: inv.role, workspace: inv.workspace });
}));

// POST /invites/:token/accept  { password, fullName }
// Creates the login for a new person, or attaches the role to an existing one.
// An invite never re-roles someone who already has a seat.
publicRouter.post('/:token/accept', asyncHandler(async (req, res) => {
  const { password, fullName } = req.body || {};
  const out = await withTransaction(async (c) => {
    const inv = (await c.query('SELECT * FROM invites WHERE token_hash=$1', [hashToken(req.params.token)])).rows[0];
    if (!inv || inv.accepted_at || new Date(inv.expires_at) < new Date()) return { err: 'invalid_invite' };

    let user = (await c.query('SELECT id FROM users WHERE email=$1', [inv.email])).rows[0];
    const existed = !!user;
    if (!user) {
      if (!password || String(password).length < 8) return { err: 'weak_password' };
      user = (await c.query(
        'INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id',
        [inv.email, await hashPassword(password), fullName || inv.email])).rows[0];
    }
    const seat = await c.query(
      `INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`, [inv.workspace_id, user.id, inv.role]);
    // Consumed either way, so a stale token cannot be replayed.
    await c.query('UPDATE invites SET accepted_at=now() WHERE id=$1', [inv.id]);
    if (seat.rowCount === 0) return { err: 'already_a_member' };
    return { userId: user.id, workspaceId: inv.workspace_id, role: inv.role, existed };
  });
  if (out.err === 'weak_password') return badRequest(res, 'weak_password', ['password']);
  if (out.err === 'already_a_member') return res.status(409).json({ error: 'already_a_member' });
  if (out.err) return res.status(404).json({ error: out.err });
  await audit({ workspaceId: out.workspaceId, actorUserId: out.userId, action: 'invite.accept', metadata: { role: out.role } });
  res.status(201).json({ ok: true, userId: out.userId, workspaceId: out.workspaceId, role: out.role, existingUser: out.existed });
}));

module.exports = { wsRouter, publicRouter, INVITABLE_ROLES };
