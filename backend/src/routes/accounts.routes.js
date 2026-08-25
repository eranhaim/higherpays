'use strict';
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, isOptStr, badRequest } = require('../util/validate');
const { maxAgentPct } = require('../services/splits');
const { resolveDataScope } = require('../auth/dataScope');
const { hasPermission } = require('../auth/permissions');

// A rev-share split has to leave room for the highest agent commission in
// the workspace; fn_post_sale refuses the sale otherwise.
async function splitTooHigh(c, workspaceId, split) {
  const agentMax = await maxAgentPct(c, workspaceId);
  return split + agentMax > 100 ? `${split}% plus an agent on ${agentMax}% would exceed 100%` : null;
}

// mergeParams so :workspaceId from the parent mount is visible here.
const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

// What an account IS, versus what it is paid. An agent works with the account
// but has no business seeing its deal, and neither has the account holder any
// business seeing anybody else's. Both are stripped below rather than filtered
// in SQL, so there is one query and one place to read the rule.
const PAY_DEAL = ['revenue_split_pct', 'revenue_model', 'salary', 'salary_increase_pct', 'agents_assigned'];
const KYC = ['compliance_status', 'age_verified'];

function visibleAccount(row, { seesPayDeal, seesKyc }) {
  const out = { ...row };
  if (!seesPayDeal) for (const f of PAY_DEAL) delete out[f];
  if (!seesKyc) for (const f of KYC) delete out[f];
  return out;
}

// GET /workspaces/:workspaceId/accounts
// An agent sees the accounts they are assigned; an account sees itself.
router.get('/', requirePermission('accounts.view'), asyncHandler(async (req, res) => {
  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    const scope = await resolveDataScope(c, req);
    const rows = (await c.query(
      `SELECT a.id, a.stage_name, a.handle, a.country, a.status,
              a.revenue_split_pct, a.revenue_model, a.salary, a.salary_increase_pct, a.brand, a.created_at,
              comp.status AS compliance_status, comp.age_verified,
              (SELECT count(*) FROM account_agents ag WHERE ag.account_id = a.id) AS agents_assigned
       FROM accounts a
       LEFT JOIN account_compliance comp ON comp.account_id = a.id
       WHERE a.workspace_id = $1
         AND ($2::uuid IS NULL OR a.id IN (SELECT account_id FROM account_agents WHERE membership_id = $2::uuid))
         AND ($3::uuid IS NULL OR a.id = $3::uuid)
       ORDER BY a.created_at DESC`,
      [wid(req),
        scope.kind === 'agent' ? scope.membershipId : null,
        scope.kind === 'account' ? scope.accountId : null])).rows;
    return { rows, scope };
  });
  const seesPayDeal = out.scope.kind === 'workspace';
  const seesKyc = hasPermission(req.membership, 'compliance.view');
  res.json({ accounts: out.rows.map((r) => visibleAccount(r, { seesPayDeal, seesKyc })) });
}));

// GET /workspaces/:workspaceId/accounts/:id
// Out of scope reads as 404, not 403, so the endpoint cannot be used to probe
// which accounts exist.
router.get('/:id', requirePermission('accounts.view'), asyncHandler(async (req, res) => {
  const data = await withWorkspace(wid(req), uid(req), async (c) => {
    const scope = await resolveDataScope(c, req);
    const acct = (await c.query(
      `SELECT id, stage_name, handle, country, status, revenue_split_pct, brand, created_at
       FROM accounts a WHERE a.workspace_id = $1 AND a.id = $2
         AND ($3::uuid IS NULL OR a.id IN (SELECT account_id FROM account_agents WHERE membership_id = $3::uuid))
         AND ($4::uuid IS NULL OR a.id = $4::uuid)`,
      [wid(req), req.params.id,
        scope.kind === 'agent' ? scope.membershipId : null,
        scope.kind === 'account' ? scope.accountId : null])).rows[0];
    if (!acct) return null;

    const comp = hasPermission(req.membership, 'compliance.view')
      ? (await c.query(
        `SELECT status, age_verified, verification_method, verified_at, expires_at
         FROM account_compliance WHERE account_id = $1`, [acct.id])).rows[0] || null
      : undefined;
    // The roster of who else works this account is team information.
    const assignments = scope.kind === 'workspace'
      ? (await c.query(
        `SELECT ag.membership_id, u.full_name, u.email
         FROM account_agents ag
         JOIN memberships m ON m.id = ag.membership_id
         JOIN users u ON u.id = m.user_id
         WHERE ag.account_id = $1`, [acct.id])).rows
      : undefined;

    if (scope.kind !== 'workspace') delete acct.revenue_split_pct;
    return { ...acct, ...(comp !== undefined ? { compliance: comp } : {}), ...(assignments ? { assignments } : {}) };
  });
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json(data);
}));

// POST /workspaces/:workspaceId/accounts
router.post('/', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  const { stageName, handle, legalName, country, revenueSplitPct, brand, revenueModel, salary, salaryIncreasePct } = req.body || {};
  if (!isStr(stageName, 100)) return badRequest(res, 'stageName is required', ['stageName']);
  if (!isOptStr(handle, 100) || !isOptStr(legalName, 200)) return badRequest(res, 'invalid text field');
  if (country != null && !/^[A-Za-z]{2}$/.test(country)) return badRequest(res, 'country must be 2 letters', ['country']);
  if (revenueModel != null && !['revshare', 'salary', 'ai'].includes(revenueModel)) return badRequest(res, 'invalid revenueModel', ['revenueModel']);
  const split = revenueSplitPct == null ? 70 : Number(revenueSplitPct);
  if (!(split >= 0 && split <= 100)) return badRequest(res, 'revenueSplitPct must be 0..100', ['revenueSplitPct']);

  const created = await withWorkspace(wid(req), uid(req), async (c) => {
    if ((revenueModel || 'revshare') === 'revshare') {
      const problem = await splitTooHigh(c, wid(req), split);
      if (problem) return { err: problem };
    }
    const acct = (await c.query(
      `INSERT INTO accounts (workspace_id, stage_name, handle, legal_name, country, revenue_split_pct, brand, revenue_model, salary, salary_increase_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::account_revenue_model,'revshare'),$9,COALESCE($10,0))
       RETURNING id, stage_name, handle, country, status, revenue_split_pct, revenue_model, salary, created_at`,
      [wid(req), stageName, handle || null, legalName || null, country ? country.toUpperCase() : null, split, brand || {}, revenueModel || null, salary != null ? Number(salary) : null, salaryIncreasePct != null ? Number(salaryIncreasePct) : null])).rows[0];
    await c.query(`INSERT INTO account_compliance (workspace_id, account_id) VALUES ($1,$2)`, [wid(req), acct.id]);
    return acct;
  });
  if (created.err) return badRequest(res, created.err, ['revenueSplitPct']);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'account.create', entityType: 'account', entityId: created.id });
  res.status(201).json(created);
}));

// PATCH /workspaces/:workspaceId/accounts/:id
router.patch('/:id', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  const allowed = ['stage_name', 'handle', 'country', 'status', 'revenue_split_pct', 'brand', 'user_id'];
  const map = { stageName: 'stage_name', handle: 'handle', country: 'country', status: 'status', revenueSplitPct: 'revenue_split_pct', brand: 'brand', userId: 'user_id' };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (req.body && k in req.body && allowed.includes(col)) { vals.push(req.body[k]); sets.push(`${col} = $${vals.length}`); }
  }
  if (!sets.length) return badRequest(res, 'no updatable fields provided');
  const newSplit = req.body.revenueSplitPct == null ? null : Number(req.body.revenueSplitPct);
  if (newSplit != null && !(newSplit >= 0 && newSplit <= 100)) return badRequest(res, 'revenueSplitPct must be 0..100', ['revenueSplitPct']);
  vals.push(wid(req), req.params.id);
  const updated = await withWorkspace(wid(req), uid(req), async (c) => {
    if (newSplit != null) {
      const problem = await splitTooHigh(c, wid(req), newSplit);
      if (problem) return { err: problem };
    }
    return (await c.query(
      `UPDATE accounts SET ${sets.join(', ')} WHERE workspace_id = $${vals.length - 1} AND id = $${vals.length}
       RETURNING id, stage_name, handle, country, status, revenue_split_pct, updated_at`, vals)).rows[0];
  });
  if (!updated) return res.status(404).json({ error: 'not_found' });
  if (updated.err) return badRequest(res, updated.err, ['revenueSplitPct']);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'account.update', entityType: 'account', entityId: updated.id });
  res.json(updated);
}));

// POST /workspaces/:workspaceId/accounts/:id/assignments  { membershipId }
router.post('/:id/assignments', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  const { membershipId } = req.body || {};
  if (!isStr(membershipId)) return badRequest(res, 'membershipId is required', ['membershipId']);
  const result = await withWorkspace(wid(req), uid(req), async (c) => {
    // Both must belong to this workspace. The membership is not required to be
    // named `agent`: a workspace may define its own agent-like role, and an
    // assignment only ever widens what a scoped member can see — for a member
    // who already sees the whole workspace it is simply inert.
    const ok = (await c.query(
      `SELECT (SELECT 1 FROM accounts WHERE id=$1 AND workspace_id=$3) AS acct,
              (SELECT 1 FROM memberships WHERE id=$2 AND workspace_id=$3 AND status='active') AS ag`,
      [req.params.id, membershipId, wid(req)])).rows[0];
    if (!ok.acct) return { err: 'account_not_found' };
    if (!ok.ag) return { err: 'agent_not_found' };
    await c.query(
      `INSERT INTO account_agents (workspace_id, account_id, membership_id)
       VALUES ($1,$2,$3) ON CONFLICT (account_id, membership_id) DO NOTHING`,
      [wid(req), req.params.id, membershipId]);
    return { ok: true };
  });
  if (result.err) return res.status(result.err.endsWith('not_found') ? 404 : 400).json({ error: result.err });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'account.assign', entityType: 'account', entityId: req.params.id, metadata: { membershipId } });
  res.status(201).json({ ok: true });
}));

// DELETE /workspaces/:workspaceId/accounts/:id/assignments/:membershipId
router.delete('/:id/assignments/:membershipId', requirePermission('accounts.manage'), asyncHandler(async (req, res) => {
  await withWorkspace(wid(req), uid(req), async (c) => c.query(
    `DELETE FROM account_agents WHERE workspace_id=$1 AND account_id=$2 AND membership_id=$3`,
    [wid(req), req.params.id, req.params.membershipId]));
  res.status(204).end();
}));

// PATCH /workspaces/:workspaceId/accounts/:id/compliance
router.patch('/:id/compliance', requirePermission('compliance.manage'), asyncHandler(async (req, res) => {
  const { status, ageVerified, verificationMethod, expiresAt, notes } = req.body || {};
  const valid = ['unverified', 'pending_review', 'verified', 'rejected', 'expired'];
  if (status != null && !valid.includes(status)) return badRequest(res, 'invalid compliance status', ['status']);
  const updated = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `UPDATE account_compliance
     SET status = COALESCE($3, status),
         age_verified = COALESCE($4, age_verified),
         verification_method = COALESCE($5, verification_method),
         expires_at = COALESCE($6, expires_at),
         notes = COALESCE($7, notes),
         verified_by = CASE WHEN $3 = 'verified' THEN $8 ELSE verified_by END,
         verified_at = CASE WHEN $3 = 'verified' THEN now() ELSE verified_at END
     WHERE workspace_id = $1 AND account_id = $2
     RETURNING status, age_verified, verification_method, verified_at, expires_at`,
    [wid(req), req.params.id, status ?? null, ageVerified ?? null, verificationMethod ?? null, expiresAt ?? null, notes ?? null, uid(req)])).rows[0]);
  if (!updated) return res.status(404).json({ error: 'not_found' });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'account.compliance.update', entityType: 'account', entityId: req.params.id, metadata: { status } });
  res.json(updated);
}));

module.exports = router;
