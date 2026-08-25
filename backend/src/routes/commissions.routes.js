'use strict';
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { badRequest } = require('../util/validate');
const { maxAccountSplitPct } = require('../services/splits');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

const pct = (v) => typeof v === 'number' && v >= 0 && v <= 100;

// GET /workspaces/:workspaceId/commissions
// Returns the current account/agent split for the workspace, plus the blended
// platform fee that applies (for display — the owner does not set this).
router.get('/', requirePermission('commissions.view'), asyncHandler(async (req, res) => {
  const data = await withWorkspace(wid(req), uid(req), async (c) => {
    const rule = (await c.query(
      `SELECT account_split_pct, agency_split_pct, agent_pct, effective_from
       FROM commission_rules
       WHERE workspace_id = $1 AND account_id IS NULL
       ORDER BY effective_from DESC LIMIT 1`, [wid(req)])).rows[0] || null;

    const org = (await c.query(`SELECT organization_id FROM workspaces WHERE id = $1`, [wid(req)])).rows[0];
    const fee = (await c.query(`SELECT * FROM effective_platform_fee($1, now())`, [org.organization_id])).rows[0] || null;
    return { rule, platformFee: fee };
  });

  res.json({
    // sensible defaults if the owner hasn't set splits yet
    commission: data.rule || { account_split_pct: 70, agency_split_pct: 30, agent_pct: 0, effective_from: null },
    platformFee: data.platformFee, // { psp_rate_pct, margin_rate_pct, blended_rate_pct } or null
  });
}));

// PUT /workspaces/:workspaceId/commissions   { accountSplitPct, agentPct }
// Open fields — the workspace owner sets these at will. Agency share is derived
// (100 − account). A new versioned row is written; history is preserved.
router.put('/', requirePermission('commissions.manage'), asyncHandler(async (req, res) => {
  const { accountSplitPct, agentPct } = req.body || {};
  if (!pct(accountSplitPct)) return badRequest(res, 'accountSplitPct must be 0..100', ['accountSplitPct']);
  if (!pct(agentPct)) return badRequest(res, 'agentPct must be 0..100', ['agentPct']);

  const agencySplit = 100 - accountSplitPct;
  if (agentPct > agencySplit) {
    return badRequest(res, 'agent commission cannot exceed the agency share', ['agentPct']);
  }

  const out = await withWorkspace(wid(req), uid(req), async (c) => {
    // Each account's own split is what the ledger applies; the new default
    // agent rate must fit next to the highest of them.
    const accountMax = await maxAccountSplitPct(c, wid(req));
    if (accountMax + agentPct > 100) return { err: `an account on ${accountMax}% plus ${agentPct}% commission would exceed 100%` };
    return { rule: (await c.query(
      `INSERT INTO commission_rules (workspace_id, account_id, account_split_pct, agency_split_pct, agent_pct, created_by)
       VALUES ($1, NULL, $2, $3, $4, $5)
       RETURNING account_split_pct, agency_split_pct, agent_pct, effective_from`,
      [wid(req), accountSplitPct, agencySplit, agentPct, uid(req)])).rows[0] };
  });
  if (out.err) return badRequest(res, out.err, ['agentPct']);

  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'commissions.update', metadata: { accountSplitPct, agentPct } });
  res.status(201).json({ commission: out.rule });
}));

module.exports = router;
