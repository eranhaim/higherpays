'use strict';
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, isOptStr, badRequest, toCSV } = require('../util/validate');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const { resolveDataScope } = require('../auth/dataScope');
const SEGMENTS = ['new', 'regular', 'high_value', 'vip', 'inactive', 'at_risk'];

// GET /workspaces/:workspaceId/customers?segment=&q=&accountId=&limit=&offset=
router.get('/', requirePermission('customers.view'), asyncHandler(async (req, res) => {
  const { segment, q, accountId } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  const rows = await withWorkspace(wid(req), uid(req), async (c) => {
    const scope = await resolveDataScope(c, req);
    const where = ['workspace_id = $1', 'deleted_at IS NULL'];
    const vals = [wid(req)];
    // accountId from the query string narrows; scope CONSTRAINS. A caller can
    // filter within what they may see, never outside it.
    vals.push(scope.kind === 'agent' ? scope.membershipId : null);
    where.push(`($${vals.length}::uuid IS NULL OR account_id IN (SELECT account_id FROM account_agents WHERE membership_id = $${vals.length}::uuid))`);
    vals.push(scope.kind === 'account' ? scope.accountId : null);
    where.push(`($${vals.length}::uuid IS NULL OR account_id = $${vals.length}::uuid)`);

    if (segment && SEGMENTS.includes(segment)) { vals.push(segment); where.push(`segment = $${vals.length}`); }
    if (accountId) { vals.push(accountId); where.push(`account_id = $${vals.length}`); }
    if (q) { vals.push(`%${q.toLowerCase()}%`); where.push(`(lower(alias) LIKE $${vals.length} OR lower(email::text) LIKE $${vals.length})`); }
    vals.push(limit, offset);
    return (await c.query(
      `SELECT id, alias, email, account_id, segment, total_spend, last_purchase_at, created_at
       FROM customers WHERE ${where.join(' AND ')}
       ORDER BY last_purchase_at DESC NULLS LAST, created_at DESC
       LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals)).rows;
  });
  res.json({ customers: rows, limit, offset });
}));

// GET /workspaces/:workspaceId/customers/export  (CSV, audited)
router.get('/export', requirePermission('customers.export'), asyncHandler(async (req, res) => {
  const rows = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `SELECT c.alias, c.email, a.stage_name AS account, c.segment, c.total_spend, c.last_purchase_at
     FROM customers c LEFT JOIN accounts a ON a.id = c.account_id
     WHERE c.workspace_id = $1 AND c.deleted_at IS NULL
     ORDER BY c.total_spend DESC`, [wid(req)])).rows);
  // Access to bulk PII is always logged.
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'customer.export', metadata: { count: rows.length }, ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0] || null });
  const csv = toCSV(
    ['alias', 'email', 'account', 'segment', 'total_spend', 'last_purchase'],
    rows.map((r) => [r.alias, r.email, r.account, r.segment, r.total_spend, r.last_purchase_at ? new Date(r.last_purchase_at).toISOString() : ''])
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="customers_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\ufeff' + csv);
}));

// GET /workspaces/:workspaceId/customers/:id
router.get('/:id', requirePermission('customers.view'), asyncHandler(async (req, res) => {
  const row = await withWorkspace(wid(req), uid(req), async (c) => {
    const scope = await resolveDataScope(c, req);
    return (await c.query(
      `SELECT id, alias, email, phone, country, account_id, segment, tags, total_spend,
              first_purchase_at, last_purchase_at, consent_marketing, created_at
       FROM customers WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
         AND ($3::uuid IS NULL OR account_id IN (SELECT account_id FROM account_agents WHERE membership_id = $3::uuid))
         AND ($4::uuid IS NULL OR account_id = $4::uuid)`,
      [wid(req), req.params.id,
        scope.kind === 'agent' ? scope.membershipId : null,
        scope.kind === 'account' ? scope.accountId : null])).rows[0];
  });
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
}));

// POST /workspaces/:workspaceId/customers
router.post('/', requirePermission('customers.manage'), asyncHandler(async (req, res) => {
  const { alias, email, phone, country, accountId, segment, consentMarketing } = req.body || {};
  if (!isStr(alias, 200)) return badRequest(res, 'alias is required', ['alias']);
  if (!isOptStr(email, 100) || !isOptStr(phone, 20)) return badRequest(res, 'invalid contact field');
  if (segment != null && !SEGMENTS.includes(segment)) return badRequest(res, 'invalid segment', ['segment']);
  const created = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `INSERT INTO customers (workspace_id, account_id, alias, email, phone, country, segment, consent_marketing, consent_recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::customer_segment,'new'),COALESCE($8::boolean,false), CASE WHEN $8::boolean THEN now() END)
     RETURNING id, alias, email, account_id, segment, created_at`,
    [wid(req), accountId || null, alias, email || null, phone || null, country ? country.toUpperCase() : null, segment || null, consentMarketing || false])).rows[0]);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'customer.create', entityType: 'customer', entityId: created.id });
  res.status(201).json(created);
}));

// PATCH /workspaces/:workspaceId/customers/:id
router.patch('/:id', requirePermission('customers.manage'), asyncHandler(async (req, res) => {
  const map = { alias: 'alias', email: 'email', phone: 'phone', country: 'country', segment: 'segment', accountId: 'account_id', consentMarketing: 'consent_marketing' };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (req.body && k in req.body) {
      if (col === 'segment' && !SEGMENTS.includes(req.body[k])) return badRequest(res, 'invalid segment', ['segment']);
      vals.push(req.body[k]); sets.push(col === 'segment' ? `${col} = $${vals.length}::customer_segment` : `${col} = $${vals.length}`);
    }
  }
  if (!sets.length) return badRequest(res, 'no updatable fields provided');
  vals.push(wid(req), req.params.id);
  const updated = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `UPDATE customers SET ${sets.join(', ')}
     WHERE workspace_id = $${vals.length - 1} AND id = $${vals.length} AND deleted_at IS NULL
     RETURNING id, alias, email, account_id, segment, updated_at`, vals)).rows[0]);
  if (!updated) return res.status(404).json({ error: 'not_found' });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'customer.update', entityType: 'customer', entityId: updated.id });
  res.json(updated);
}));

// DELETE /workspaces/:workspaceId/customers/:id  — soft delete + anonymize (GDPR erasure)
router.delete('/:id', requirePermission('customers.manage'), asyncHandler(async (req, res) => {
  const done = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `UPDATE customers
     SET deleted_at = now(), alias = 'deleted', email = NULL, phone = NULL, tags = '[]'::jsonb
     WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
     RETURNING id`, [wid(req), req.params.id])).rows[0]);
  if (!done) return res.status(404).json({ error: 'not_found' });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'customer.erase', entityType: 'customer', entityId: req.params.id });
  res.status(204).end();
}));

module.exports = router;
