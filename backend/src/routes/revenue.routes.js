'use strict';
// The workspace's default split: what a new account and a new agent start on.
// The ledger reads each account's and agent's own rate, so changing the
// default never re-prices anyone already set up.
const express = require('express');
const { query } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { badRequest } = require('../util/validate');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const pct = (v) => typeof v === 'number' && v >= 0 && v <= 100;

const publicRule = (r) => ({
  accountSplitPct: Number(r.account_split_pct), agencySplitPct: Number(r.agency_split_pct),
  agentPct: Number(r.agent_pct), effectiveFrom: r.effective_from,
});

// GET / — the current default split and the blended platform rate.
router.get('/', requirePermission('revenue.view'), asyncHandler(async (req, res) => {
  const rule = (await query(
    `SELECT * FROM revenue_rules WHERE workspace_id = $1 AND account_id IS NULL
      ORDER BY effective_from DESC LIMIT 1`, [wid(req)])).rows[0];
  const blended = (await query('SELECT workspace_blended_rate($1) AS pct', [wid(req)])).rows[0];
  res.json({
    rule: rule ? publicRule(rule) : { accountSplitPct: 70, agencySplitPct: 30, agentPct: 0, effectiveFrom: null },
    blendedRatePct: Number(blended.pct),
  });
}));

// PUT /  { accountSplitPct, agentPct } — a new versioned row; history stays.
router.put('/', requirePermission('revenue.manage'), asyncHandler(async (req, res) => {
  const { accountSplitPct, agentPct } = req.body || {};
  if (!pct(accountSplitPct)) return badRequest(res, 'accountSplitPct must be 0..100', ['accountSplitPct']);
  if (!pct(agentPct)) return badRequest(res, 'agentPct must be 0..100', ['agentPct']);
  const agencySplit = 100 - accountSplitPct;
  if (agentPct > agencySplit) return badRequest(res, 'agent commission cannot exceed the agency share', ['agentPct']);

  const rule = (await query(
    `INSERT INTO revenue_rules (workspace_id, account_id, account_split_pct, agency_split_pct, agent_pct, created_by_user_id)
     VALUES ($1, NULL, $2, $3, $4, $5) RETURNING *`,
    [wid(req), accountSplitPct, agencySplit, agentPct, uid(req)])).rows[0];
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'revenue.rule.update', metadata: { accountSplitPct, agentPct } });
  res.status(201).json({ rule: publicRule(rule) });
}));

module.exports = router;
