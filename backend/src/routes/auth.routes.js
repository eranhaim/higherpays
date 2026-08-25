'use strict';
const express = require('express');
const { query, withPlatformAdmin, withUser } = require('../db');
const { hashPassword, verifyPassword } = require('../auth/passwords');
const { signAccessToken, generateRefreshToken, hashRefreshToken } = require('../auth/tokens');
const { seedRolesForWorkspace } = require('../auth/permissions');
const { requireAuth } = require('../middleware');
const { generateSecret, verifyTotp, otpauthUrl } = require('../auth/totp');
const { asyncHandler, audit } = require('../util/audit');
const { createLimiter } = require('../lib/rateLimit');
const { TooManyRequestsError } = require('../lib/errors');
const config = require('../config');

const router = express.Router();
// req.ip honours X-Forwarded-For only from the trusted proxy (see server.js).
const ipOf = (req) => req.ip || null;

// Brute-force protection. Per-IP limits cap the request rate; the per-account
// limiter counts only failed sign-ins so a correct password is never blocked
// by someone else's guesses from another address.
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ipLimiter = createLimiter({ windowMs: FIFTEEN_MINUTES, max: 100 });
const accountFailures = createLimiter({ windowMs: FIFTEEN_MINUTES, max: 10 });
const limitByIp = ipLimiter.middleware((req) => ipOf(req) || 'unknown');
const accountKey = (email) => String(email || '').trim().toLowerCase();

// A new sign-in starts a token family; rotation continues the same one.
async function issueRefreshToken(userId, req, familyId = null) {
  const token = generateRefreshToken();
  const expires = new Date(Date.now() + config.refreshTokenDays * 86400 * 1000);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip, family_id)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6, gen_random_uuid()))`,
    [userId, hashRefreshToken(token), expires, req.headers['user-agent'] || null, ipOf(req), familyId]
  );
  return token;
}

// POST /auth/register — self-serve signup that bootstraps a new tenant:
// creates an organization + its first workspace + the owner user + membership.
router.post('/register', asyncHandler(async (req, res) => {
  const { email, password, fullName, organizationName } = req.body || {};
  if (!email || !password || !fullName || !organizationName) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (String(password).length < 8) return res.status(400).json({ error: 'weak_password' });

  const exists = await query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (exists.rows.length) return res.status(409).json({ error: 'email_taken' });

  const created = await withPlatformAdmin(null, async (client) => {
    const pwHash = await hashPassword(password);
    const slug = organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.random().toString(36).slice(2, 7);

    const org = (await client.query(
      'INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id', [organizationName, slug]
    )).rows[0];
    const ws = (await client.query(
      "INSERT INTO workspaces (organization_id, name, currency, provider_name) VALUES ($1,$2,'EUR','mantapay') RETURNING id",
      [org.id, organizationName]
    )).rows[0];
    const user = (await client.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id, email, full_name',
      [email, pwHash, fullName]
    )).rows[0];
    await client.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [ws.id, user.id]
    );
    await seedRolesForWorkspace(client, ws.id);
    return { org, ws, user };
  });

  const { ws, user } = created;
  await audit({ workspaceId: ws.id, actorUserId: user.id, action: 'auth.register', ip: ipOf(req) });
  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id, req);
  res.status(201).json({
    accessToken, refreshToken,
    user: { id: user.id, email: user.email, fullName: user.full_name },
    workspaces: [{ id: ws.id, role: 'owner', name: organizationName }],
  });
}));

// POST /auth/login
router.post('/login', limitByIp, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
  if (accountFailures.isBlocked(accountKey(email))) {
    await audit({ action: 'auth.login.locked', metadata: { email }, ip: ipOf(req) });
    throw new TooManyRequestsError('Too many failed sign-ins. Try again in 15 minutes.', { retryAfterSeconds: 900 });
  }

  const { rows } = await query(
    "SELECT id, email, full_name, password_hash, status, twofa_secret, twofa_enabled FROM users WHERE email = $1", [email]
  );
  const user = rows[0];
  // Same response whether the user exists or not (avoid user enumeration).
  if (!user || !user.password_hash || user.status !== 'active' || !(await verifyPassword(password, user.password_hash))) {
    accountFailures.hit(accountKey(email));
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  // Second factor: if enabled, require a valid TOTP before issuing any tokens.
  if (user.twofa_enabled) {
    const { totp } = req.body || {};
    if (!totp) return res.json({ twoFactorRequired: true });
    if (!verifyTotp(user.twofa_secret, totp)) {
      accountFailures.hit(accountKey(email));
      await audit({ actorUserId: user.id, action: 'auth.2fa.failed', ip: ipOf(req) });
      return res.json({ twoFactorRequired: true });
    }
  }

  accountFailures.reset(accountKey(email));
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  const memberships = await withUser(user.id, async (c) => (await c.query(
    `SELECT m.workspace_id AS id, m.role, w.name
     FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 AND m.status = 'active'`, [user.id])).rows);

  await audit({ actorUserId: user.id, action: 'auth.login', ip: ipOf(req) });
  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id, req);
  res.json({
    accessToken, refreshToken,
    user: { id: user.id, email: user.email, fullName: user.full_name, twoFactorEnabled: !!user.twofa_enabled },
    workspaces: memberships,
  });
}));

// ---- Two-factor (TOTP) ----------------------------------------------------
// POST /auth/2fa/setup — create a pending secret + provisioning URI (QR/manual)
router.post('/2fa/setup', limitByIp, requireAuth, asyncHandler(async (req, res) => {
  const u = (await query('SELECT email, twofa_enabled FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'not_found' });
  if (u.twofa_enabled) return res.status(400).json({ error: 'already_enabled' });
  const secret = generateSecret();
  await query('UPDATE users SET twofa_secret = $1 WHERE id = $2', [secret, req.user.id]);
  res.json({ secret, otpauthUrl: otpauthUrl(secret, { issuer: 'HigherPays', account: u.email }) });
}));

// POST /auth/2fa/enable — confirm a code from the app, then turn 2FA on
router.post('/2fa/enable', limitByIp, requireAuth, asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  const u = (await query('SELECT twofa_secret, twofa_enabled FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!u || !u.twofa_secret) return res.status(400).json({ error: 'no_pending_secret' });
  if (u.twofa_enabled) return res.status(400).json({ error: 'already_enabled' });
  if (!verifyTotp(u.twofa_secret, code)) return res.status(400).json({ error: 'invalid_code' });
  await query('UPDATE users SET twofa_enabled = true WHERE id = $1', [req.user.id]);
  await audit({ actorUserId: req.user.id, action: 'auth.2fa.enabled', ip: ipOf(req) });
  res.json({ enabled: true });
}));

// POST /auth/2fa/disable — requires a valid current code
router.post('/2fa/disable', limitByIp, requireAuth, asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  const u = (await query('SELECT twofa_secret, twofa_enabled FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!u || !u.twofa_enabled) return res.json({ enabled: false });
  if (!verifyTotp(u.twofa_secret, code)) return res.status(400).json({ error: 'invalid_code' });
  await query('UPDATE users SET twofa_enabled = false, twofa_secret = NULL WHERE id = $1', [req.user.id]);
  await audit({ actorUserId: req.user.id, action: 'auth.2fa.disabled', ip: ipOf(req) });
  res.json({ enabled: false });
}));

// POST /auth/refresh — rotate the refresh token, issue a new access token
router.post('/refresh', limitByIp, asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'missing_token' });
  const hash = hashRefreshToken(refreshToken);

  const { rows } = await query(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at, rt.family_id, u.email, u.full_name
     FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1`, [hash]
  );
  const rec = rows[0];
  if (!rec) return res.status(401).json({ error: 'invalid_refresh' });
  if (rec.revoked_at) {
    // A rotated token presented again was copied. Nobody can tell which
    // holder is the real user, so the whole session chain ends.
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [rec.family_id]);
    await audit({ actorUserId: rec.user_id, action: 'auth.refresh.reuse', metadata: { familyId: rec.family_id }, ip: ipOf(req) });
    return res.status(401).json({ error: 'refresh_token_reused' });
  }
  if (new Date(rec.expires_at) < new Date()) return res.status(401).json({ error: 'invalid_refresh' });
  // rotate: revoke the old, issue the next one in the same family
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [rec.id]);
  const newRefresh = await issueRefreshToken(rec.user_id, req, rec.family_id);
  const accessToken = signAccessToken({ id: rec.user_id, email: rec.email, full_name: rec.full_name });
  res.json({ accessToken, refreshToken: newRefresh });
}));

// POST /auth/logout — revoke a refresh token
router.post('/logout', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashRefreshToken(refreshToken)]);
  }
  res.status(204).end();
}));

// ---- Sessions -------------------------------------------------------------
// A session is a refresh-token family. Listing shows where the account is
// signed in; revoking a family signs that device out at its next refresh.

// GET /auth/sessions  — active sessions for the signed-in user
router.get('/sessions', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT ON (family_id) family_id, user_agent, ip, created_at, expires_at
       FROM refresh_tokens
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY family_id, created_at DESC`, [req.user.id]);
  res.json({
    sessions: rows.map((r) => ({
      id: r.family_id, userAgent: r.user_agent, ip: r.ip, lastRefreshedAt: r.created_at, expiresAt: r.expires_at,
    })),
  });
}));

// DELETE /auth/sessions/:id — sign out one session
router.delete('/sessions/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND family_id = $2 AND revoked_at IS NULL',
    [req.user.id, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  await audit({ actorUserId: req.user.id, action: 'auth.session.revoke', metadata: { familyId: req.params.id }, ip: ipOf(req) });
  res.status(204).end();
}));

// POST /auth/sessions/revoke-others  { refreshToken } — keep this device only
router.post('/sessions/revoke-others', requireAuth, asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'missing_token' });
  const mine = (await query(
    'SELECT family_id FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2 AND revoked_at IS NULL',
    [req.user.id, hashRefreshToken(refreshToken)])).rows[0];
  if (!mine) return res.status(401).json({ error: 'invalid_refresh' });
  const { rowCount } = await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND family_id <> $2 AND revoked_at IS NULL',
    [req.user.id, mine.family_id]);
  await audit({ actorUserId: req.user.id, action: 'auth.session.revoke_others', metadata: { revoked: rowCount }, ip: ipOf(req) });
  res.json({ revoked: rowCount });
}));

// GET /auth/me — current user + workspaces
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const memberships = await withUser(req.user.id, async (c) => (await c.query(
    `SELECT m.workspace_id AS id, m.role, w.name
     FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 AND m.status = 'active'`, [req.user.id])).rows);
  res.json({ user: req.user, workspaces: memberships });
}));


// GET /auth/me/workspaces — every workspace this user belongs to (multi-workspace).
router.get('/me/workspaces', requireAuth, asyncHandler(async (req, res) => {
  const rows = (await query(
    `SELECT m.workspace_id AS id, m.role, m.status, w.name, w.currency, o.name AS organization
       FROM memberships m
       JOIN workspaces w ON w.id = m.workspace_id
       JOIN organizations o ON o.id = w.organization_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY o.name, w.name`, [req.user.id])).rows;
  res.json({ workspaces: rows });
}));

module.exports = router;
