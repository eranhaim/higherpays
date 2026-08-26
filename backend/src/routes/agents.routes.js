'use strict';
const express = require('express');
const { query, withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, badRequest } = require('../util/validate');
const { maxAccountSplitPct } = require('../services/splits');
const { grantWorkspaceRole } = require('../services/people');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

const publicAgent = (r) => ({
  id: r.id, userId: r.user_id, name: r.name, email: r.email, status: r.status,
  country: r.country, commissionPct: Number(r.commission_pct),
  accountsAssigned: Number(r.accounts_assigned || 0), createdAt: r.created_at,
});

const SELECT = `
  SELECT ag.id, ag.user_id, ag.country, ag.commission_pct, ag.created_at,
         u.full_name AS name, u.email, wu.status,
         (SELECT count(*) FROM account_agents aa WHERE aa.agent_id = ag.id) AS accounts_assigned
    FROM agents ag
    JOIN users u ON u.id = ag.user_id
    JOIN workspace_users wu ON wu.workspace_id = ag.workspace_id AND wu.user_id = ag.user_id`;

// A commission has to fit next to the highest account share in the workspace.
async function commissionTooHigh(c, workspaceId, pct) {
  const accountMax = await maxAccountSplitPct(c, workspaceId);
  return accountMax + pct > 100 ? `an account on ${accountMax}% plus ${pct}% commission would exceed 100%` : null;
}

// GET /
router.get('/', requirePermission('agents.view'), asyncHandler(async (req, res) => {
  const rows = (await query(`${SELECT} WHERE ag.workspace_id = $1 ORDER BY u.full_name`, [wid(req)])).rows;
  res.json({ agents: rows.map(publicAgent) });
}));

// POST /  { email, fullName, password?, country?, commissionPct? }
// Creates the login, the access, and the agent in one go.
router.post('/', requirePermission('agents.manage'), asyncHandler(async (req, res) => {
  const { email, fullName, password, country, commissionPct } = req.body || {};
  if (!isStr(email, 100) || !email.includes('@')) return badRequest(res, 'a valid email is required', ['email']);
  if (!isStr(fullName, 120)) return badRequest(res, 'fullName is required', ['fullName']);
  if (country != null && !/^[A-Za-z]{2}$/.test(country)) return badRequest(res, 'country must be 2 letters', ['country']);
  const pct = commissionPct == null ? 0 : Number(commissionPct);
  if (!(pct >= 0 && pct <= 100)) return badRequest(res, 'commissionPct must be 0..100', ['commissionPct']);

  const out = await withTransaction(async (c) => {
    const problem = await commissionTooHigh(c, wid(req), pct);
    if (problem) return { err: problem, fields: ['commissionPct'] };
    const grant = await grantWorkspaceRole(c, wid(req), { email, fullName, password }, 'agent');
    if (grant.err === 'weak_password') return { err: 'password of at least 8 characters is required for a new login', fields: ['password'] };
    if (grant.err) return { err: `this person is already a ${grant.role} here`, fields: ['email'] };
    const existing = (await c.query('SELECT 1 FROM agents WHERE workspace_id=$1 AND user_id=$2', [wid(req), grant.userId])).rows[0];
    if (existing) return { err: 'this person is already an agent here', fields: ['email'] };
    const created = (await c.query(
      'INSERT INTO agents (workspace_id, user_id, country, commission_pct) VALUES ($1,$2,$3,$4) RETURNING id',
      [wid(req), grant.userId, country ? country.toUpperCase() : null, pct])).rows[0];
    return { row: (await c.query(`${SELECT} WHERE ag.id = $1`, [created.id])).rows[0] };
  });
  if (out.err) return badRequest(res, out.err, out.fields);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'agent.create', entityType: 'agent', entityId: out.row.id });
  res.status(201).json(publicAgent(out.row));
}));

// PATCH /:id  { commissionPct?, country? }
router.patch('/:id', requirePermission('agents.manage'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const sets = [], vals = [];
  const pct = body.commissionPct == null ? null : Number(body.commissionPct);
  if (pct != null) {
    if (!(pct >= 0 && pct <= 100)) return badRequest(res, 'commissionPct must be 0..100', ['commissionPct']);
    vals.push(pct); sets.push(`commission_pct = $${vals.length}`);
  }
  if ('country' in body) {
    if (body.country != null && !/^[A-Za-z]{2}$/.test(body.country)) return badRequest(res, 'country must be 2 letters', ['country']);
    vals.push(body.country ? body.country.toUpperCase() : null); sets.push(`country = $${vals.length}`);
  }
  if (!sets.length) return badRequest(res, 'no updatable fields provided');
  vals.push(wid(req), req.params.id);

  const out = await withTransaction(async (c) => {
    if (pct != null) {
      const problem = await commissionTooHigh(c, wid(req), pct);
      if (problem) return { err: problem };
    }
    const updated = (await c.query(
      `UPDATE agents SET ${sets.join(', ')} WHERE workspace_id = $${vals.length - 1} AND id = $${vals.length} RETURNING id`, vals)).rows[0];
    if (!updated) return { notFound: true };
    return { row: (await c.query(`${SELECT} WHERE ag.id = $1`, [updated.id])).rows[0] };
  });
  if (out.notFound) return res.status(404).json({ error: 'not_found' });
  if (out.err) return badRequest(res, out.err, ['commissionPct']);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'agent.update', entityType: 'agent', entityId: out.row.id, metadata: body });
  res.json(publicAgent(out.row));
}));

module.exports = router;
