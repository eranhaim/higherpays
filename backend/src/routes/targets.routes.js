'use strict';
// KPI targets + live workspace leaderboard. Admins (team.manage) set goals;
// everyone with analytics.view can read the leaderboard and their targets.
// Actuals are aggregated from the commission ledger for the chosen period.
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const config = require('../config');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const { resolveDataScope } = require('../auth/dataScope');
const num = (v) => Number(v || 0);
const METRICS = ['gross', 'sales', 'aov', 'buyers', 'conversion'];
const PERIODS = ['day', 'week', 'month', 'quarter'];

function periodRange(period) {
  const now = new Date(); let from;
  if (period === 'day') { from = new Date(now); from.setHours(0, 0, 0, 0); }
  else if (period === 'week') { from = new Date(now); from.setDate(now.getDate() - now.getDay()); from.setHours(0, 0, 0, 0); }
  else if (period === 'quarter') { from = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1); }
  else { from = new Date(now.getFullYear(), now.getMonth(), 1); }
  return { from: from.toISOString(), to: now.toISOString() };
}

// GET / — list all targets in the workspace (with member names)
router.get('/', requirePermission('analytics.view'), asyncHandler(async (req, res) => {
  const rows = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(`
    SELECT t.id, t.membership_id, t.metric, t.target_value, t.period, u.full_name AS member_name
    FROM kpi_targets t
    LEFT JOIN memberships m ON m.id = t.membership_id
    LEFT JOIN users u ON u.id = m.user_id
    ORDER BY u.full_name NULLS FIRST, t.metric`)).rows);
  res.json({ targets: rows.map((r) => ({ id: r.id, membershipId: r.membership_id, metric: r.metric, targetValue: num(r.target_value), period: r.period, memberName: r.member_name || null })) });
}));

// POST / — upsert a target { membershipId?, metric, targetValue, period }
router.post('/', requirePermission('team.manage'), asyncHandler(async (req, res) => {
  const { membershipId = null, metric, targetValue, period = 'month' } = req.body || {};
  if (!METRICS.includes(metric)) return res.status(400).json({ error: 'invalid_metric' });
  if (targetValue == null || isNaN(+targetValue) || +targetValue < 0) return res.status(400).json({ error: 'invalid_target' });
  if (!PERIODS.includes(period)) return res.status(400).json({ error: 'invalid_period' });
  const row = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(`
    INSERT INTO kpi_targets (workspace_id, membership_id, metric, target_value, period, created_by)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (workspace_id, COALESCE(membership_id,'00000000-0000-0000-0000-000000000000'::uuid), metric, period)
    DO UPDATE SET target_value = EXCLUDED.target_value, updated_at = now()
    RETURNING id`, [wid(req), membershipId, metric, +targetValue, period, uid(req)])).rows[0]);
  res.json({ id: row.id, ok: true });
}));

// DELETE /:id — remove a target
router.delete('/:id', requirePermission('team.manage'), asyncHandler(async (req, res) => {
  await withWorkspace(wid(req), uid(req), (c) => c.query('DELETE FROM kpi_targets WHERE id = $1', [req.params.id]));
  res.json({ ok: true });
}));

// GET /leaderboard?period=&from=&to= — agent actuals vs targets, ranked.
// This board is about agents, so an account has no place on it or in it.
router.get('/leaderboard', requirePermission('analytics.view'), asyncHandler(async (req, res) => {
  const period = PERIODS.includes(req.query.period) ? req.query.period : 'month';
  let { from, to } = periodRange(period);
  if (req.query.from) from = new Date(req.query.from).toISOString();
  if (req.query.to) to = new Date(req.query.to).toISOString();

  const data = await withWorkspace(wid(req), uid(req), async (c) => {
    const scope = await resolveDataScope(c, req);
    if (scope.kind === 'account') return { forbidden: true };
    const led = (await c.query(`
      SELECT m.id AS membership_id, u.full_name AS name,
             COALESCE(SUM(ce.gross),0) AS gross,
             COUNT(*) FILTER (WHERE ce.entry_type='sale') AS sales,
             COUNT(DISTINCT t.customer_id) FILTER (WHERE ce.entry_type='sale') AS buyers
      FROM commission_entries ce
      JOIN transactions t ON t.id = ce.transaction_id
      JOIN memberships m ON m.id = ce.agent_membership_id
      JOIN users u ON u.id = m.user_id
      WHERE t.occurred_at >= $1 AND t.occurred_at <= $2
      GROUP BY m.id, u.full_name`, [from, to])).rows;
    const links = (await c.query(`
      SELECT pl.created_by AS membership_id, COUNT(*) AS created, COUNT(*) FILTER (WHERE pl.status='paid') AS paid
      FROM payment_links pl WHERE pl.created_at >= $1 AND pl.created_at <= $2 AND pl.created_by IS NOT NULL
      GROUP BY pl.created_by`, [from, to])).rows;
    const members = (await c.query(`
      SELECT m.id AS membership_id, u.full_name AS name
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.role = 'agent' AND m.status = 'active'`)).rows;
    const targets = (await c.query('SELECT membership_id, metric, target_value FROM kpi_targets WHERE period = $1', [period])).rows;
    return { led, links, members, targets, scope };
  });
  if (data.forbidden) return res.status(403).json({ error: 'forbidden' });

  const lmap = Object.fromEntries(data.links.map((r) => [r.membership_id, r]));
  const ledmap = Object.fromEntries(data.led.map((r) => [r.membership_id, r]));
  const tByMember = {}; const wsTargets = {};
  data.targets.forEach((t) => {
    if (t.membership_id) (tByMember[t.membership_id] = tByMember[t.membership_id] || {})[t.metric] = num(t.target_value);
    else wsTargets[t.metric] = num(t.target_value);
  });
  const ids = new Set([...data.members.map((m) => m.membership_id), ...data.led.map((r) => r.membership_id)]);
  const full = [...ids].map((id) => {
    const l = ledmap[id] || {}; const lk = lmap[id];
    const name = (data.members.find((m) => m.membership_id === id) || l).name || '—';
    const gross = num(l.gross), sales = num(l.sales), buyers = num(l.buyers);
    const created = lk ? num(lk.created) : 0, paid = lk ? num(lk.paid) : 0;
    const actuals = { gross, sales, buyers, aov: sales ? +(gross / sales).toFixed(2) : 0, conversion: created ? +(paid / created * 100).toFixed(1) : 0 };
    return { membershipId: id, name, actuals, targets: tByMember[id] || {} };
  }).sort((a, b) => b.actuals.gross - a.actuals.gross);

  // The entity model gives an agent a LIMITED leaderboard: where they place,
  // not what everyone earns. Rank is computed here so the figures never leave
  // the server; their own row stays complete.
  const rows = data.scope.kind === 'workspace' ? full : full.map((r, i) => (
    r.membershipId === data.scope.membershipId
      ? { ...r, rank: i + 1 }
      : { membershipId: r.membershipId, name: r.name, rank: i + 1 }
  ));
  res.json({ period, from, to, metrics: METRICS, rows, workspaceTargets: wsTargets });
}));

module.exports = router;
