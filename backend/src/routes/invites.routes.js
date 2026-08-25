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

const { wid, uid } = require('../lib/scope');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ---- workspace-scoped: create + list invites (mounted under /workspaces/:id) ----
const wsRouter = express.Router({ mergeParams: true });

// POST /workspaces/:wid/invites  { email, role, creatorId? }
wsRouter.post('/', requireAuth, requireWorkspace, requirePermission('team.manage'), asyncHandler(async (req, res) => {
  const { email, role, creatorId } = req.body || {};
  if (!isStr(email, 100) || !isStr(role, 40)) return badRequest(res, 'email and role are required', ['email', 'role']);
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + 7 * 86400 * 1000);
  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    const roleOk = (await c.query('SELECT 1 FROM roles WHERE workspace_id=$1 AND name=$2', [wid(req), role])).rows[0];
    if (!roleOk) return { err: 'unknown_role' };
    const row = (await c.query(
      `INSERT INTO invites (workspace_id, email, role, creator_id, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, email, role, expires_at`,
      [wid(req), email, role, creatorId || null, hashToken(token), uid(req), expires])).rows[0];
    return { row };
  });
  if (out.err) return res.status(400).json({ error: out.err });
  const link = `https://app.higherpays.com/accept-invite?token=${token}`;
  await sendEmail({ to: email, subject: `You're invited to HigherPays (${role})`, body: `Set up your login: ${link}` });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'invite.create', metadata: { email, role } });
  // token returned here only so the flow is testable before real email is wired
  res.status(201).json({ ...out.row, inviteToken: token });
}));

// GET /workspaces/:wid/invites — pending invites
wsRouter.get('/', requireAuth, requireWorkspace, requirePermission('team.view'), asyncHandler(async (req, res) => {
  const rows = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `SELECT id, email, role, expires_at, accepted_at FROM invites WHERE workspace_id=$1 ORDER BY created_at DESC`, [wid(req)])).rows);
  res.json({ invites: rows });
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
    // existing person: we simply add the membership. Their password is untouched.
    await c.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role=EXCLUDED.role, status='active'`,
      [inv.workspace_id, user.id, inv.role]);
    await c.query('UPDATE invites SET accepted_at=now() WHERE id=$1', [inv.id]);
    return { user, workspaceId: inv.workspace_id, role: inv.role, existing: !!existed };
  });
  if (out.err === 'weak_password') return badRequest(res, 'weak_password', ['password']);
  if (out.err) return res.status(404).json({ error: out.err });
  await audit({ workspaceId: out.workspaceId, actorUserId: out.user.id, action: 'invite.accept', metadata: { role: out.role } });
  res.status(201).json({ ok: true, userId: out.user.id, workspaceId: out.workspaceId, role: out.role, existingUser: !!out.existing });
}));

module.exports = { wsRouter, publicRouter };
