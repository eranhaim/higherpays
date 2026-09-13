'use strict';

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireArchiveManager, requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { wid, uid } = require('../lib/scope');

const router = express.Router({ mergeParams: true });

const TYPES = new Set(['links', 'payments', 'creators', 'agents', 'customers', 'team', 'workspaces']);

function archivedItem(type, row) {
  return {
    id: row.id,
    type,
    name: row.name,
    detail: row.detail || null,
    status: row.status || null,
    amount: row.amount == null ? null : Number(row.amount),
    currency: row.currency || null,
    archivedAt: row.archived_at,
  };
}

async function listArchived(type, workspaceId) {
  const queries = {
    links: `
      SELECT pl.id, COALESCE(NULLIF(pl.description, ''), pl.reference_id) AS name,
             pl.reference_id AS detail, pl.status, pl.amount, pl.currency, pl.archived_at
        FROM payment_links pl
       WHERE pl.workspace_id = $1 AND pl.archived_at IS NOT NULL
       ORDER BY pl.archived_at DESC, pl.id DESC`,
    payments: `
      SELECT p.id, COALESCE(pl.reference_id, p.provider_payment_id, p.id::text) AS name,
             a.name AS detail, p.status, p.amount, p.currency, p.archived_at
        FROM payments p
        JOIN accounts a ON a.id = p.account_id
        LEFT JOIN payment_links pl ON pl.id = p.payment_link_id
       WHERE p.workspace_id = $1 AND p.archived_at IS NOT NULL
       ORDER BY p.archived_at DESC, p.id DESC`,
    creators: `
      SELECT a.id, a.name, u.email AS detail, a.status, NULL::numeric AS amount,
             NULL::text AS currency, a.updated_at AS archived_at
        FROM accounts a
        JOIN users u ON u.id = a.user_id
       WHERE a.workspace_id = $1 AND a.status = 'archived'
       ORDER BY a.updated_at DESC, a.id DESC`,
    agents: `
      SELECT ag.id, u.full_name AS name, u.email AS detail, wu.status,
             NULL::numeric AS amount, NULL::text AS currency, wu.updated_at AS archived_at
        FROM agents ag
        JOIN users u ON u.id = ag.user_id
        JOIN workspace_users wu ON wu.workspace_id = ag.workspace_id AND wu.user_id = ag.user_id
       WHERE ag.workspace_id = $1 AND wu.status <> 'active'
       ORDER BY wu.updated_at DESC, ag.id DESC`,
    customers: `
      SELECT c.id, c.name, COALESCE(c.email::text, c.phone, '') AS detail,
             c.segment AS status, NULL::numeric AS amount, NULL::text AS currency,
             c.archived_at
        FROM customers c
       WHERE c.workspace_id = $1 AND c.archived_at IS NOT NULL AND c.deleted_at IS NULL
       ORDER BY c.archived_at DESC, c.id DESC`,
    team: `
      SELECT wu.user_id AS id, u.full_name AS name,
             COALESCE(u.email::text, '') AS detail, wu.status,
             NULL::numeric AS amount, NULL::text AS currency, wu.updated_at AS archived_at
        FROM workspace_users wu
        JOIN users u ON u.id = wu.user_id
       WHERE wu.workspace_id = $1 AND wu.status <> 'active' AND wu.role <> 'workspace_owner'
       ORDER BY wu.updated_at DESC, wu.user_id DESC`,
    workspaces: `
      SELECT w.id, w.name, w.currency AS detail, w.status,
             NULL::numeric AS amount, w.currency, w.updated_at AS archived_at
        FROM workspaces w
       WHERE w.id = $1 AND w.status = 'archived'
       ORDER BY w.updated_at DESC, w.id DESC`,
  };
  const rows = (await query(queries[type], [workspaceId])).rows;
  return rows.map((row) => archivedItem(type, row));
}

router.get('/', requirePermission('archive.manage'), requireArchiveManager, asyncHandler(async (req, res) => {
  const type = String(req.query.type || 'links');
  if (!TYPES.has(type)) return res.status(400).json({ error: 'invalid_archive_type' });
  res.json({ type, items: await listArchived(type, wid(req)) });
}));

router.post('/:type/:id/restore', requirePermission('archive.manage'), requireArchiveManager, asyncHandler(async (req, res) => {
  const type = String(req.params.type);
  if (!TYPES.has(type)) return res.status(400).json({ error: 'invalid_archive_type' });
  if (type === 'workspaces') return res.status(400).json({ error: 'workspace_restore_uses_platform_route' });

  const updates = {
    links: {
      sql: `UPDATE payment_links SET archived_at = NULL
              WHERE workspace_id = $1 AND id = $2 AND archived_at IS NOT NULL`,
      entityType: 'payment_link',
    },
    payments: {
      sql: `UPDATE payments SET archived_at = NULL
              WHERE workspace_id = $1 AND id = $2 AND archived_at IS NOT NULL`,
      entityType: 'payment',
    },
    creators: {
      sql: `UPDATE accounts SET status = 'active'
              WHERE workspace_id = $1 AND id = $2 AND status = 'archived'`,
      entityType: 'account',
    },
    agents: {
      sql: `UPDATE workspace_users wu SET status = 'active'
              FROM agents ag
             WHERE ag.workspace_id = $1 AND ag.id = $2
               AND wu.workspace_id = ag.workspace_id AND wu.user_id = ag.user_id
               AND wu.status <> 'active'`,
      entityType: 'agent',
    },
    customers: {
      sql: `UPDATE customers SET archived_at = NULL
              WHERE workspace_id = $1 AND id = $2 AND archived_at IS NOT NULL
                AND deleted_at IS NULL`,
      entityType: 'customer',
    },
    team: {
      sql: `UPDATE workspace_users SET status = 'active'
              WHERE workspace_id = $1 AND user_id = $2
                AND status <> 'active' AND role <> 'workspace_owner'`,
      entityType: 'user',
    },
  }[type];

  let result;
  if (type === 'payments') {
    result = await withTransaction(async (c) => {
      const restored = await c.query(updates.sql + ' RETURNING id, customer_id', [wid(req), req.params.id]);
      const customerId = restored.rows[0]?.customer_id;
      if (customerId) {
        await c.query(
          `UPDATE customers SET
              total_spend = (SELECT COALESCE(SUM(amount), 0)
                               FROM payments
                              WHERE customer_id = $1 AND status = 'paid'
                                AND review_reason IS NULL AND archived_at IS NULL),
              last_purchase_at = (SELECT MAX(occurred_at)
                                    FROM payments
                                   WHERE customer_id = $1 AND status = 'paid'
                                     AND archived_at IS NULL)
            WHERE id = $1`,
          [customerId]);
      }
      return restored;
    });
  } else {
    result = await query(updates.sql, [wid(req), req.params.id]);
  }
  if (result.rowCount === 0) return res.status(404).json({ error: 'not_found_or_active' });
  await audit({
    workspaceId: wid(req),
    actorUserId: uid(req),
    action: 'archive.restore',
    entityType: updates.entityType,
    entityId: req.params.id,
    metadata: { archiveType: type },
  });
  res.json({ id: req.params.id, type, restored: true });
}));

module.exports = { router, listArchived };
