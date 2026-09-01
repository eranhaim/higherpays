'use strict';
const express = require('express');
const { query, withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, isOptStr, badRequest } = require('../util/validate');
const { maxAgentPct } = require('../services/splits');
const { grantWorkspaceRole } = require('../services/people');
const { createInvite } = require('../services/invites');
const { resolveDataScope, scopeParams, ASSIGNED_ACCOUNTS } = require('../auth/dataScope');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

const ACCOUNT_STATUS = ['active', 'paused', 'archived'];

// Every account row the caller may see: an agent the ones they are assigned,
// an owner their own, everyone else the whole workspace.
const SCOPE_WHERE = `AND ($2::uuid IS NULL OR a.id IN (${ASSIGNED_ACCOUNTS.replace('$1', '$2')}))
                     AND ($3::uuid IS NULL OR a.id = $3::uuid)`;

// The share is the account's deal with the agency. An agent works with the
// account but has no business seeing it; the owner sees their own.
function visible(row, scope) {
  const out = {
    id: row.id, name: row.name, handle: row.handle, country: row.country, status: row.status,
    userId: row.user_id, ownerName: row.owner_name, ownerEmail: row.owner_email,
    createdAt: row.created_at,
  };
  if (scope.kind === 'workspace') {
    out.revenueSplitPct = Number(row.revenue_split_pct);
    out.agentsAssigned = Number(row.agents_assigned || 0);
  } else if (scope.kind === 'account') {
    out.revenueSplitPct = Number(row.revenue_split_pct);
  }
  return out;
}

// A share has to leave room for the highest agent commission in the workspace;
// fn_post_sale refuses the sale otherwise.
async function splitTooHigh(c, workspaceId, split) {
  const agentMax = await maxAgentPct(c, workspaceId);
  return split + agentMax > 100 ? `${split}% plus an agent on ${agentMax}% would exceed 100%` : null;
}

// GET /
router.get('/', requirePermission('accounts.view'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);
    const rows = (await c.query(
      `SELECT a.*, u.full_name AS owner_name, u.email AS owner_email,
              (SELECT count(*) FROM account_agents ag WHERE ag.account_id = a.id) AS agents_assigned
         FROM accounts a JOIN users u ON u.id = a.user_id
        WHERE a.workspace_id = $1 ${SCOPE_WHERE}
        ORDER BY a.created_at DESC`, [wid(req), ...scopeParams(scope)])).rows;
    return { rows, scope };
  });
  res.json({ accounts: out.rows.map((r) => visible(r, out.scope)) });
}));

// GET /:id — out of scope reads as 404, so the endpoint cannot probe which
// accounts exist.
router.get('/:id', requirePermission('accounts.view'), asyncHandler(async (req, res) => {
  const data = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);
    const row = (await c.query(
      `SELECT a.*, u.full_name AS owner_name, u.email AS owner_email,
              (SELECT count(*) FROM account_agents ag WHERE ag.account_id = a.id) AS agents_assigned
         FROM accounts a JOIN users u ON u.id = a.user_id
        WHERE a.workspace_id = $1 AND a.id = $4 ${SCOPE_WHERE}`,
      [wid(req), ...scopeParams(scope), req.params.id])).rows[0];
    if (!row) return null;
    const account = visible(row, scope);
    // The roster of who works this account is team information.
    if (scope.kind === 'workspace') {
      account.agents = (await c.query(
        `SELECT ag.id AS agent_id, u.full_name AS name, u.email
           FROM account_agents aa JOIN agents ag ON ag.id = aa.agent_id JOIN users u ON u.id = ag.user_id
          WHERE aa.account_id = $1 ORDER BY u.full_name`, [row.id])).rows.map((r) => ({ agentId: r.agent_id, name: r.name, email: r.email }));
    }
    return account;
  });
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json(data);
}));

// POST /  { email, fullName, name, handle?, country?, revenueSplitPct? }
// Creates the owner's login, their access, and the account in one go. A login
// that did not exist is created without a password and invited: the owner sets
// their own, rather than the agency choosing one for them.
router.post('/', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  const { email, fullName, name, handle, country, revenueSplitPct } = req.body || {};
  if (!isStr(email, 100) || !email.includes('@')) return badRequest(res, 'a valid email is required', ['email']);
  if (!isStr(fullName, 120)) return badRequest(res, 'fullName is required', ['fullName']);
  if (!isStr(name, 100)) return badRequest(res, 'name is required', ['name']);
  if (!isOptStr(handle, 100)) return badRequest(res, 'invalid handle', ['handle']);
  if (country != null && !/^[A-Za-z]{2}$/.test(country)) return badRequest(res, 'country must be 2 letters', ['country']);
  const split = revenueSplitPct == null ? 70 : Number(revenueSplitPct);
  if (!(split >= 0 && split <= 100)) return badRequest(res, 'revenueSplitPct must be 0..100', ['revenueSplitPct']);

  const out = await withTransaction(async (c) => {
    const problem = await splitTooHigh(c, wid(req), split);
    if (problem) return { err: problem, fields: ['revenueSplitPct'] };
    const grant = await grantWorkspaceRole(c, wid(req), { email, fullName }, 'account_owner');
    if (grant.err) return { err: `this person is already a ${grant.role} here`, fields: ['email'] };
    const existing = (await c.query('SELECT 1 FROM accounts WHERE workspace_id=$1 AND user_id=$2', [wid(req), grant.userId])).rows[0];
    if (existing) return { err: 'this person already owns an account here', fields: ['email'] };
    const row = (await c.query(
      `INSERT INTO accounts (workspace_id, user_id, name, handle, country, revenue_split_pct)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [wid(req), grant.userId, name.trim(), handle || null, country ? country.toUpperCase() : null, split])).rows[0];
    if (grant.isNewLogin) {
      await createInvite(c, {
        workspaceId: wid(req), email, role: 'account_owner', invitedByUserId: uid(req),
        subject: 'Your HigherPays login', intro: `${name.trim()} has been set up on HigherPays.`,
      });
    }
    return { row: { ...row, owner_name: fullName, owner_email: email }, invited: grant.isNewLogin };
  });
  if (out.err) return badRequest(res, out.err, out.fields);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'account.create', entityType: 'account', entityId: out.row.id });
  res.status(201).json({ ...visible(out.row, { kind: 'workspace' }), invited: out.invited });
}));

// PATCH /:id  { name?, handle?, country?, status?, revenueSplitPct? }
router.patch('/:id', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const sets = [], vals = [];
  if ('name' in body) { if (!isStr(body.name, 100)) return badRequest(res, 'name is required', ['name']); vals.push(body.name.trim()); sets.push(`name = $${vals.length}`); }
  if ('handle' in body) { if (!isOptStr(body.handle, 100)) return badRequest(res, 'invalid handle', ['handle']); vals.push(body.handle || null); sets.push(`handle = $${vals.length}`); }
  if ('country' in body) {
    if (body.country != null && !/^[A-Za-z]{2}$/.test(body.country)) return badRequest(res, 'country must be 2 letters', ['country']);
    vals.push(body.country ? body.country.toUpperCase() : null); sets.push(`country = $${vals.length}`);
  }
  if ('status' in body) { if (!ACCOUNT_STATUS.includes(body.status)) return badRequest(res, 'invalid status', ['status']); vals.push(body.status); sets.push(`status = $${vals.length}`); }
  const newSplit = body.revenueSplitPct == null ? null : Number(body.revenueSplitPct);
  if (newSplit != null) {
    if (!(newSplit >= 0 && newSplit <= 100)) return badRequest(res, 'revenueSplitPct must be 0..100', ['revenueSplitPct']);
    vals.push(newSplit); sets.push(`revenue_split_pct = $${vals.length}`);
  }
  if (!sets.length) return badRequest(res, 'no updatable fields provided');
  vals.push(wid(req), req.params.id);

  const out = await withTransaction(async (c) => {
    if (newSplit != null) {
      const problem = await splitTooHigh(c, wid(req), newSplit);
      if (problem) return { err: problem };
    }
    const row = (await c.query(
      `UPDATE accounts SET ${sets.join(', ')} WHERE workspace_id = $${vals.length - 1} AND id = $${vals.length} RETURNING *`, vals)).rows[0];
    if (!row) return { notFound: true };
    const owner = (await c.query('SELECT full_name, email FROM users WHERE id = $1', [row.user_id])).rows[0];
    return { row: { ...row, owner_name: owner.full_name, owner_email: owner.email } };
  });
  if (out.notFound) return res.status(404).json({ error: 'not_found' });
  if (out.err) return badRequest(res, out.err, ['revenueSplitPct']);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'account.update', entityType: 'account', entityId: out.row.id, metadata: body });
  res.json(visible(out.row, { kind: 'workspace' }));
}));

// POST /:id/agents  { agentId } — assign an agent. The composite keys make a
// cross-workspace pair impossible, so a bad id simply fails to insert.
router.post('/:id/agents', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  const { agentId } = req.body || {};
  if (!isStr(agentId)) return badRequest(res, 'agentId is required', ['agentId']);
  const ok = (await query(
    `SELECT (SELECT 1 FROM accounts WHERE id=$1 AND workspace_id=$3) AS acct,
            (SELECT 1 FROM agents WHERE id=$2 AND workspace_id=$3) AS ag`, [req.params.id, agentId, wid(req)])).rows[0];
  if (!ok.acct) return res.status(404).json({ error: 'account_not_found' });
  if (!ok.ag) return res.status(404).json({ error: 'agent_not_found' });
  await query(
    'INSERT INTO account_agents (workspace_id, account_id, agent_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [wid(req), req.params.id, agentId]);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'account.assign', entityType: 'account', entityId: req.params.id, metadata: { agentId } });
  res.status(201).json({ ok: true });
}));

// DELETE /:id/agents/:agentId
router.delete('/:id/agents/:agentId', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  await query('DELETE FROM account_agents WHERE workspace_id=$1 AND account_id=$2 AND agent_id=$3',
    [wid(req), req.params.id, req.params.agentId]);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'account.unassign', entityType: 'account', entityId: req.params.id, metadata: { agentId: req.params.agentId } });
  res.status(204).end();
}));

module.exports = router;
