'use strict';
const express = require('express');
const { query } = require('../db');
const { verifyPassword } = require('../auth/passwords');
const { signAccessToken, generateRefreshToken, hashRefreshToken } = require('../auth/tokens');
const { requireAuth } = require('../middleware');
const { generateSecret, verifyTotp, otpauthUrl } = require('../auth/totp');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
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
  const row = (await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip, family_id)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6, gen_random_uuid()))
     RETURNING family_id`,
    [userId, hashRefreshToken(token), expires, req.headers['user-agent'] || null, ipOf(req), familyId]
  )).rows[0];
  return { token, familyId: row.family_id };
}

// Every workspace the user may sign into, with the vocabulary that workspace
// uses so the console can label itself before loading anything else.
async function workspacesFor(userId) {
  return (await query(
    `SELECT w.id, w.name, w.currency, wu.role, w.status,
            w.account_label, w.account_label_plural, w.agent_label, w.agent_label_plural
       FROM workspace_users wu JOIN workspaces w ON w.id = wu.workspace_id
      WHERE wu.user_id = $1 AND wu.status = 'active' AND w.status = 'active'
      ORDER BY w.name`, [userId])).rows.map((w) => ({
    id: w.id, name: w.name, currency: w.currency, role: w.role, status: w.status,
    labels: { account: w.account_label, accounts: w.account_label_plural, agent: w.agent_label, agents: w.agent_label_plural },
  }));
}

const publicUser = (u) => ({
  id: u.id, email: u.email, fullName: u.full_name,
  isPlatformAdmin: !!u.is_platform_admin, twoFactorEnabled: !!u.two_factor_enabled,
});

// POST /auth/login
router.post('/login', limitByIp, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
  if (accountFailures.isBlocked(accountKey(email))) {
    await audit({ action: 'auth.login.locked', metadata: { email }, ip: ipOf(req) });
    throw new TooManyRequestsError('Too many failed sign-ins. Try again in 15 minutes.', { retryAfterSeconds: 900 });
  }

  const user = (await query(
    `SELECT id, email, full_name, password_hash, status, is_platform_admin, two_factor_secret, two_factor_enabled
       FROM users WHERE email = $1`, [email])).rows[0];
  // Same response whether the user exists or not (avoid user enumeration).
  if (!user || !user.password_hash || user.status !== 'active' || !(await verifyPassword(password, user.password_hash))) {
    accountFailures.hit(accountKey(email));
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  if (user.two_factor_enabled) {
    const { totp } = req.body || {};
    if (!totp) return res.json({ twoFactorRequired: true });
    if (!verifyTotp(user.two_factor_secret, totp)) {
      accountFailures.hit(accountKey(email));
      await audit({ actorUserId: user.id, action: 'auth.2fa.failed', ip: ipOf(req) });
      return res.json({ twoFactorRequired: true });
    }
  }

  accountFailures.reset(accountKey(email));
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await audit({ actorUserId: user.id, action: 'auth.login', ip: ipOf(req) });
  const session = await issueRefreshToken(user.id, req);
  res.json({
    accessToken: signAccessToken(user, session.familyId),
    refreshToken: session.token,
    user: publicUser(user),
    workspaces: await workspacesFor(user.id),
  });
}));

// ---- Two-factor (TOTP) ----------------------------------------------------
router.post('/2fa/setup', limitByIp, requireAuth, asyncHandler(async (req, res) => {
  const u = (await query('SELECT email, two_factor_enabled FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'not_found' });
  if (u.two_factor_enabled) return res.status(400).json({ error: 'already_enabled' });
  const secret = generateSecret();
  await query('UPDATE users SET two_factor_secret = $1 WHERE id = $2', [secret, req.user.id]);
  res.json({ secret, otpauthUrl: otpauthUrl(secret, { issuer: 'HigherPays', account: u.email }) });
}));

router.post('/2fa/enable', limitByIp, requireAuth, asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  const u = (await query('SELECT two_factor_secret, two_factor_enabled FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!u || !u.two_factor_secret) return res.status(400).json({ error: 'no_pending_secret' });
  if (u.two_factor_enabled) return res.status(400).json({ error: 'already_enabled' });
  if (!verifyTotp(u.two_factor_secret, code)) return res.status(400).json({ error: 'invalid_code' });
  await query('UPDATE users SET two_factor_enabled = true WHERE id = $1', [req.user.id]);
  await audit({ actorUserId: req.user.id, action: 'auth.2fa.enabled', ip: ipOf(req) });
  res.json({ enabled: true });
}));

router.post('/2fa/disable', limitByIp, requireAuth, asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  const u = (await query('SELECT two_factor_secret, two_factor_enabled FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!u || !u.two_factor_enabled) return res.json({ enabled: false });
  if (!verifyTotp(u.two_factor_secret, code)) return res.status(400).json({ error: 'invalid_code' });
  await query('UPDATE users SET two_factor_enabled = false, two_factor_secret = NULL WHERE id = $1', [req.user.id]);
  await audit({ actorUserId: req.user.id, action: 'auth.2fa.disabled', ip: ipOf(req) });
  res.json({ enabled: false });
}));

// POST /auth/refresh — rotate the refresh token, issue a new access token
router.post('/refresh', limitByIp, asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'missing_token' });
  const hash = hashRefreshToken(refreshToken);

  const rec = (await query(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at, rt.family_id, u.email, u.full_name
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1`, [hash])).rows[0];
  if (!rec) return res.status(401).json({ error: 'invalid_refresh' });
  if (rec.revoked_at) {
    // A rotated token presented again was copied. Nobody can tell which
    // holder is the real user, so the whole session chain ends.
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [rec.family_id]);
    await audit({ actorUserId: rec.user_id, action: 'auth.refresh.reuse', metadata: { familyId: rec.family_id }, ip: ipOf(req) });
    return res.status(401).json({ error: 'refresh_token_reused' });
  }
  if (new Date(rec.expires_at) < new Date()) return res.status(401).json({ error: 'invalid_refresh' });
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [rec.id]);
  const next = await issueRefreshToken(rec.user_id, req, rec.family_id);
  const accessToken = signAccessToken({ id: rec.user_id, email: rec.email, full_name: rec.full_name }, next.familyId);
  res.json({ accessToken, refreshToken: next.token });
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

// ---- Sessions: a session is a refresh-token family -------------------------
router.get('/sessions', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT DISTINCT ON (family_id) family_id, user_agent, ip, created_at, expires_at
       FROM refresh_tokens
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY family_id, created_at DESC`, [req.user.id]);
  res.json({
    sessions: rows.map((r) => ({
      id: r.family_id, userAgent: r.user_agent, ip: r.ip, lastRefreshedAt: r.created_at, expiresAt: r.expires_at,
      isCurrent: r.family_id === req.user.sessionId,
    })),
  });
}));

router.delete('/sessions/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND family_id = $2 AND revoked_at IS NULL',
    [req.user.id, req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  await audit({ actorUserId: req.user.id, action: 'auth.session.revoke', metadata: { familyId: req.params.id }, ip: ipOf(req) });
  res.status(204).end();
}));

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
  const user = (await query(
    'SELECT id, email, full_name, is_platform_admin, two_factor_enabled FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!user) return res.status(401).json({ error: 'invalid_token' });
  res.json({ user: publicUser(user), workspaces: await workspacesFor(user.id) });
}));

module.exports = router;
