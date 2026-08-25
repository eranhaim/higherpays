'use strict';
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, isOptStr, badRequest } = require('../util/validate');
const { maxChatterPct } = require('../services/splits');

// A rev-share split has to leave room for the highest chatter commission in
// the workspace; fn_post_sale refuses the sale otherwise.
async function splitTooHigh(c, workspaceId, split) {
  const chatterMax = await maxChatterPct(c, workspaceId);
  return split + chatterMax > 100 ? `${split}% plus a chatter on ${chatterMax}% would exceed 100%` : null;
}

// mergeParams so :workspaceId from the parent mount is visible here.
const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

// GET /workspaces/:workspaceId/creators
router.get('/', requirePermission('creators.view'), asyncHandler(async (req, res) => {
  const rows = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `SELECT cr.id, cr.stage_name, cr.handle, cr.country, cr.status,
            cr.revenue_split_pct, cr.revenue_model, cr.salary, cr.salary_increase_pct, cr.brand, cr.created_at,
            comp.status AS compliance_status, comp.age_verified,
            (SELECT count(*) FROM creator_assignments a WHERE a.creator_id = cr.id) AS chatters_assigned
     FROM creators cr
     LEFT JOIN creator_compliance comp ON comp.creator_id = cr.id
     WHERE cr.workspace_id = $1
     ORDER BY cr.created_at DESC`, [wid(req)])).rows);
  res.json({ creators: rows });
}));

// GET /workspaces/:workspaceId/creators/:id
router.get('/:id', requirePermission('creators.view'), asyncHandler(async (req, res) => {
  const data = await withWorkspace(wid(req), uid(req), async (c) => {
    const cr = (await c.query(
      `SELECT id, stage_name, handle, country, status, revenue_split_pct, brand, created_at
       FROM creators WHERE workspace_id = $1 AND id = $2`, [wid(req), req.params.id])).rows[0];
    if (!cr) return null;
    const comp = (await c.query(
      `SELECT status, age_verified, verification_method, verified_at, expires_at
       FROM creator_compliance WHERE creator_id = $1`, [cr.id])).rows[0] || null;
    const assignments = (await c.query(
      `SELECT a.membership_id, u.full_name, u.email
       FROM creator_assignments a
       JOIN memberships m ON m.id = a.membership_id
       JOIN users u ON u.id = m.user_id
       WHERE a.creator_id = $1`, [cr.id])).rows;
    return { ...cr, compliance: comp, assignments };
  });
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json(data);
}));

// POST /workspaces/:workspaceId/creators
router.post('/', requirePermission('creators.manage'), asyncHandler(async (req, res) => {
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
    const cr = (await c.query(
      `INSERT INTO creators (workspace_id, stage_name, handle, legal_name, country, revenue_split_pct, brand, revenue_model, salary, salary_increase_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::creator_revenue_model,'revshare'),$9,COALESCE($10,0))
       RETURNING id, stage_name, handle, country, status, revenue_split_pct, revenue_model, salary, created_at`,
      [wid(req), stageName, handle || null, legalName || null, country ? country.toUpperCase() : null, split, brand || {}, revenueModel || null, salary != null ? Number(salary) : null, salaryIncreasePct != null ? Number(salaryIncreasePct) : null])).rows[0];
    await c.query(`INSERT INTO creator_compliance (workspace_id, creator_id) VALUES ($1,$2)`, [wid(req), cr.id]);
    return cr;
  });
  if (created.err) return badRequest(res, created.err, ['revenueSplitPct']);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'creator.create', entityType: 'creator', entityId: created.id });
  res.status(201).json(created);
}));

// PATCH /workspaces/:workspaceId/creators/:id
router.patch('/:id', requirePermission('creators.manage'), asyncHandler(async (req, res) => {
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
      `UPDATE creators SET ${sets.join(', ')} WHERE workspace_id = $${vals.length - 1} AND id = $${vals.length}
       RETURNING id, stage_name, handle, country, status, revenue_split_pct, updated_at`, vals)).rows[0];
  });
  if (!updated) return res.status(404).json({ error: 'not_found' });
  if (updated.err) return badRequest(res, updated.err, ['revenueSplitPct']);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'creator.update', entityType: 'creator', entityId: updated.id });
  res.json(updated);
}));

// POST /workspaces/:workspaceId/creators/:id/assignments  { membershipId }
router.post('/:id/assignments', requirePermission('creators.manage'), asyncHandler(async (req, res) => {
  const { membershipId } = req.body || {};
  if (!isStr(membershipId)) return badRequest(res, 'membershipId is required', ['membershipId']);
  const result = await withWorkspace(wid(req), uid(req), async (c) => {
    // ensure both creator and membership belong to this workspace
    const ok = (await c.query(
      `SELECT (SELECT 1 FROM creators WHERE id=$1 AND workspace_id=$3) AS cr,
              (SELECT 1 FROM memberships WHERE id=$2 AND workspace_id=$3 AND role='chatter') AS ch`,
      [req.params.id, membershipId, wid(req)])).rows[0];
    if (!ok.cr) return { err: 'creator_not_found' };
    if (!ok.ch) return { err: 'chatter_not_found' };
    await c.query(
      `INSERT INTO creator_assignments (workspace_id, creator_id, membership_id)
       VALUES ($1,$2,$3) ON CONFLICT (creator_id, membership_id) DO NOTHING`,
      [wid(req), req.params.id, membershipId]);
    return { ok: true };
  });
  if (result.err) return res.status(result.err.endsWith('not_found') ? 404 : 400).json({ error: result.err });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'creator.assign', entityType: 'creator', entityId: req.params.id, metadata: { membershipId } });
  res.status(201).json({ ok: true });
}));

// DELETE /workspaces/:workspaceId/creators/:id/assignments/:membershipId
router.delete('/:id/assignments/:membershipId', requirePermission('creators.manage'), asyncHandler(async (req, res) => {
  await withWorkspace(wid(req), uid(req), async (c) => c.query(
    `DELETE FROM creator_assignments WHERE workspace_id=$1 AND creator_id=$2 AND membership_id=$3`,
    [wid(req), req.params.id, req.params.membershipId]));
  res.status(204).end();
}));

// PATCH /workspaces/:workspaceId/creators/:id/compliance
router.patch('/:id/compliance', requirePermission('compliance.manage'), asyncHandler(async (req, res) => {
  const { status, ageVerified, verificationMethod, expiresAt, notes } = req.body || {};
  const valid = ['unverified', 'pending_review', 'verified', 'rejected', 'expired'];
  if (status != null && !valid.includes(status)) return badRequest(res, 'invalid compliance status', ['status']);
  const updated = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `UPDATE creator_compliance
     SET status = COALESCE($3, status),
         age_verified = COALESCE($4, age_verified),
         verification_method = COALESCE($5, verification_method),
         expires_at = COALESCE($6, expires_at),
         notes = COALESCE($7, notes),
         verified_by = CASE WHEN $3 = 'verified' THEN $8 ELSE verified_by END,
         verified_at = CASE WHEN $3 = 'verified' THEN now() ELSE verified_at END
     WHERE workspace_id = $1 AND creator_id = $2
     RETURNING status, age_verified, verification_method, verified_at, expires_at`,
    [wid(req), req.params.id, status ?? null, ageVerified ?? null, verificationMethod ?? null, expiresAt ?? null, notes ?? null, uid(req)])).rows[0]);
  if (!updated) return res.status(404).json({ error: 'not_found' });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'creator.compliance.update', entityType: 'creator', entityId: req.params.id, metadata: { status } });
  res.json(updated);
}));

module.exports = router;
