'use strict';
// Customers belong to the workspace. They meet an account only through a
// payment link, so there is no account column and no account scope here.
const express = require('express');
const { query } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, isOptStr, badRequest, toCSV } = require('../util/validate');
const { status } = require('../schema/entities');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const SEGMENTS = status.CUSTOMER_SEGMENT;

const publicCustomer = (r) => ({
  id: r.id, name: r.name, telegramName: r.telegram_name, email: r.email, phone: r.phone, country: r.country,
  segment: r.segment, totalSpend: Number(r.total_spend), lastPurchaseAt: r.last_purchase_at, createdAt: r.created_at,
});

// What a caller may sort by. Not free text: the key picks the column.
// Mirrored in frontend/src/api/endpoints/customers.ts.
const CUSTOMER_SORTS = { name: 'name', spend: 'total_spend', last: 'last_purchase_at', segment: 'segment' };

// GET /?segment=&q=&sort=&dir=&limit=&offset=
router.get('/', requirePermission('customers.view'), asyncHandler(async (req, res) => {
  const { segment, q } = req.query;
  const sortColumn = CUSTOMER_SORTS[req.query.sort] || CUSTOMER_SORTS.last;
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  const where = ['workspace_id = $1', 'deleted_at IS NULL'];
  const vals = [wid(req)];
  if (segment && SEGMENTS.includes(segment)) { vals.push(segment); where.push(`segment = $${vals.length}`); }
  if (q) {
    vals.push(`%${String(q).toLowerCase()}%`);
    where.push(`(lower(name) LIKE $${vals.length} OR lower(email::text) LIKE $${vals.length}
                 OR lower(coalesce(telegram_name,'')) LIKE $${vals.length} OR lower(coalesce(phone,'')) LIKE $${vals.length})`);
  }
  vals.push(limit, offset);
  const rows = (await query(
    `SELECT * FROM customers WHERE ${where.join(' AND ')}
      ORDER BY ${sortColumn} ${dir} NULLS LAST, created_at DESC
      LIMIT ${vals.length - 1} OFFSET ${vals.length}`, vals)).rows;
  res.json({ customers: rows.map(publicCustomer), limit, offset });
}));

// GET /export  (CSV, audited: bulk PII access is always logged)
router.get('/export', requirePermission('customers.export'), asyncHandler(async (req, res) => {
  const rows = (await query(
    `SELECT name, telegram_name, email, phone, segment, total_spend, last_purchase_at
       FROM customers WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY total_spend DESC`, [wid(req)])).rows;
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'customer.export', metadata: { count: rows.length }, ip: req.ip || null });
  const csv = toCSV(
    ['name', 'telegram', 'email', 'phone', 'segment', 'total_spend', 'last_purchase'],
    rows.map((r) => [r.name, r.telegram_name, r.email, r.phone, r.segment, r.total_spend, r.last_purchase_at ? new Date(r.last_purchase_at).toISOString() : '']),
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="customers_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + csv);
}));

// GET /:id — the profile plus its payment history.
router.get('/:id', requirePermission('customers.view'), asyncHandler(async (req, res) => {
  const row = (await query(
    'SELECT * FROM customers WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL', [wid(req), req.params.id])).rows[0];
  if (!row) return res.status(404).json({ error: 'not_found' });
  const payments = (await query(
    `SELECT p.id, p.amount, p.currency, p.status, p.occurred_at, a.name AS account, u.full_name AS agent
       FROM payments p
       JOIN accounts a ON a.id = p.account_id
       LEFT JOIN agents ag ON ag.id = p.agent_id LEFT JOIN users u ON u.id = ag.user_id
      WHERE p.workspace_id = $1 AND p.customer_id = $2
      ORDER BY p.occurred_at DESC LIMIT 100`, [wid(req), row.id])).rows;
  res.json({
    ...publicCustomer(row),
    payments: payments.map((p) => ({
      id: p.id, amount: Number(p.amount), currency: p.currency, status: p.status, occurredAt: p.occurred_at,
      account: p.account, agent: p.agent,
    })),
  });
}));

const validateContact = (res, b) => {
  if (!isStr(b.name, 200)) return badRequest(res, 'name is required', ['name']);
  if (!isOptStr(b.telegramName, 100) || !isOptStr(b.email, 100) || !isOptStr(b.phone, 30)) return badRequest(res, 'invalid contact field');
  if (b.segment != null && !SEGMENTS.includes(b.segment)) return badRequest(res, 'invalid segment', ['segment']);
  return null;
};

// POST /  { name, telegramName?, email?, phone?, country?, segment? }
router.post('/', requirePermission('customers.manage'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const invalid = validateContact(res, b);
  if (invalid) return invalid;
  const row = (await query(
    `INSERT INTO customers (workspace_id, name, telegram_name, email, phone, country, segment)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'new')) RETURNING *`,
    [wid(req), b.name.trim(), b.telegramName || null, b.email || null, b.phone || null,
      b.country ? String(b.country).toUpperCase() : null, b.segment || null])).rows[0];
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'customer.create', entityType: 'customer', entityId: row.id });
  res.status(201).json(publicCustomer(row));
}));

// PATCH /:id
router.patch('/:id', requirePermission('customers.manage'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const map = { name: 'name', telegramName: 'telegram_name', email: 'email', phone: 'phone', country: 'country', segment: 'segment' };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (!(k in b)) continue;
    if (k === 'name' && !isStr(b.name, 200)) return badRequest(res, 'name is required', ['name']);
    if (k === 'segment' && !SEGMENTS.includes(b.segment)) return badRequest(res, 'invalid segment', ['segment']);
    vals.push(b[k] === '' ? null : b[k]); sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return badRequest(res, 'no updatable fields provided');
  vals.push(wid(req), req.params.id);
  const row = (await query(
    `UPDATE customers SET ${sets.join(', ')}
      WHERE workspace_id = $${vals.length - 1} AND id = $${vals.length} AND deleted_at IS NULL RETURNING *`, vals)).rows[0];
  if (!row) return res.status(404).json({ error: 'not_found' });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'customer.update', entityType: 'customer', entityId: row.id });
  res.json(publicCustomer(row));
}));

// DELETE /:id — soft delete + anonymise (erasure request)
router.delete('/:id', requirePermission('customers.manage'), asyncHandler(async (req, res) => {
  const done = (await query(
    `UPDATE customers
        SET deleted_at = now(), name = 'deleted', telegram_name = NULL, email = NULL, phone = NULL
      WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING id`, [wid(req), req.params.id])).rows[0];
  if (!done) return res.status(404).json({ error: 'not_found' });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'customer.erase', entityType: 'customer', entityId: req.params.id });
  res.status(204).end();
}));

module.exports = router;
