'use strict';
// The sale categories an agent picks from when completing a paid payment.
const express = require('express');
const { query } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { isStr, badRequest } = require('../util/validate');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

const publicCategory = (r) => ({ id: r.id, name: r.name, active: r.active, createdAt: r.created_at });

// GET /?all=true — active ones by default; `all` keeps compatibility with
// older clients that could display inactive categories.
router.get('/', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const all = req.query.all === 'true';
  const rows = (await query(
    `SELECT * FROM categories WHERE workspace_id = $1 AND ($2::boolean OR active) ORDER BY name`, [wid(req), all])).rows;
  res.json({ categories: rows.map(publicCategory) });
}));

// POST /  { name }
router.post('/', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const { name } = req.body || {};
  if (!isStr(name, 60)) return badRequest(res, 'name is required', ['name']);
  const dup = (await query('SELECT 1 FROM categories WHERE workspace_id=$1 AND lower(name)=lower($2)', [wid(req), name.trim()])).rows[0];
  if (dup) return res.status(409).json({ error: 'category_exists' });
  const row = (await query(
    'INSERT INTO categories (workspace_id, name) VALUES ($1,$2) RETURNING *', [wid(req), name.trim()])).rows[0];
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'category.create', entityType: 'category', entityId: row.id, metadata: { name: row.name } });
  res.status(201).json(publicCategory(row));
}));

// PATCH /:id  { name?, active? }
router.patch('/:id', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const sets = [], vals = [];
  if ('name' in body) { if (!isStr(body.name, 60)) return badRequest(res, 'name is required', ['name']); vals.push(body.name.trim()); sets.push(`name = $${vals.length}`); }
  if ('active' in body) { vals.push(!!body.active); sets.push(`active = $${vals.length}`); }
  if (!sets.length) return badRequest(res, 'no updatable fields provided');
  vals.push(wid(req), req.params.id);
  const row = (await query(
    `UPDATE categories SET ${sets.join(', ')} WHERE workspace_id = $${vals.length - 1} AND id = $${vals.length} RETURNING *`, vals)).rows[0];
  if (!row) return res.status(404).json({ error: 'not_found' });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'category.update', entityType: 'category', entityId: row.id, metadata: body });
  res.json(publicCategory(row));
}));

// DELETE /:id — category references on historical payments become NULL by the
// database's ON DELETE SET NULL rule; payment amounts and records stay intact.
router.delete('/:id', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const row = (await query(
    'DELETE FROM categories WHERE workspace_id = $1 AND id = $2 RETURNING id, name',
    [wid(req), req.params.id],
  )).rows[0];
  if (!row) return res.status(404).json({ error: 'not_found' });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'category.delete', entityType: 'category', entityId: row.id, metadata: { name: row.name } });
  res.status(204).end();
}));

module.exports = router;
