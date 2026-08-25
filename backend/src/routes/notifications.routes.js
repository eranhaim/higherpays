'use strict';
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const notify = require('../notify');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const num = (v) => (v == null ? null : Number(v));


// The events this user may see (role permits) AND wants to see (their preference).
async function effectiveEvents(c, req) {
  const allowed = notify.eventsAllowedFor(req.membership.permissions);
  const pref = (await c.query(
    'SELECT events FROM notification_preferences WHERE workspace_id=$1 AND user_id=$2',
    [wid(req), uid(req)])).rows[0];
  if (!pref) return allowed;                      // no preference set => everything permitted
  return allowed.filter((e) => pref.events.includes(e));
}

// GET / — the in-app feed for this workspace + this user's unread count
router.get('/', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 30);
  const data = await withWorkspace(wid(req), uid(req), async (c) => {
    const events = await effectiveEvents(c, req);
    if (!events.length) return { rows: [], unread: 0 };
    const rows = (await c.query(
      `SELECT n.*, (r.user_id IS NOT NULL) AS read
         FROM notifications n
         LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $1
        WHERE n.event = ANY($3::text[])
        ORDER BY n.created_at DESC LIMIT $2`, [uid(req), limit, events])).rows;
    const unread = (await c.query(
      `SELECT count(*) AS c FROM notifications n
        WHERE n.event = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id=n.id AND r.user_id=$1)`,
      [uid(req), events])).rows[0].c;
    return { rows, unread: Number(unread) };
  });
  res.json({
    unread: data.unread,
    notifications: data.rows.map((n) => ({
      id: n.id, event: n.event, title: n.title, body: n.body,
      amount: num(n.amount), currency: n.currency, read: n.read, createdAt: n.created_at,
      entityType: n.entity_type, entityId: n.entity_id,
    })),
  });
}));

// POST /read  { ids?: [] }  — mark specific (or all) notifications read for this user
router.post('/read', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const ids = (req.body && req.body.ids) || null;
  await withWorkspace(wid(req), uid(req), async (c) => {
    if (ids && ids.length) {
      await c.query(
        `INSERT INTO notification_reads (notification_id, user_id)
         SELECT id, $2 FROM notifications WHERE id = ANY($1::uuid[])
         ON CONFLICT DO NOTHING`, [ids, uid(req)]);
    } else {
      await c.query(
        `INSERT INTO notification_reads (notification_id, user_id)
         SELECT id, $1 FROM notifications ON CONFLICT DO NOTHING`, [uid(req)]);
    }
  });
  res.json({ ok: true });
}));

// GET /preferences — what this user receives, and what their role allows them to pick
router.get('/preferences', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const allowed = notify.eventsAllowedFor(req.membership.permissions);
  const row = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    'SELECT events FROM notification_preferences WHERE workspace_id=$1 AND user_id=$2',
    [wid(req), uid(req)])).rows[0]);
  res.json({
    available: allowed,
    events: row ? allowed.filter((e) => row.events.includes(e)) : allowed,
    usingDefaults: !row,
  });
}));

// PUT /preferences  { events: [] } — a user can only subscribe to events their role permits
router.put('/preferences', requirePermission('payments.view'), asyncHandler(async (req, res) => {
  const wanted = (req.body && req.body.events) || [];
  if (!Array.isArray(wanted)) return res.status(400).json({ error: 'events_must_be_array' });
  const allowed = notify.eventsAllowedFor(req.membership.permissions);
  const bad = wanted.filter((e) => !allowed.includes(e));
  if (bad.length) return res.status(403).json({ error: 'event_not_permitted', detail: bad.join(',') });

  await withWorkspace(wid(req), uid(req), (c) => c.query(
    `INSERT INTO notification_preferences (workspace_id, user_id, events)
     VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET events=EXCLUDED.events, updated_at=now()`,
    [wid(req), uid(req), wanted]));
  res.json({ ok: true, events: wanted, available: allowed });
}));

// GET /channels — configured external channels
router.get('/channels', requirePermission('settings.view'), asyncHandler(async (req, res) => {
  const rows = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    'SELECT id, type, target, label, events, active, last_error, last_sent_at FROM notification_channels ORDER BY created_at')).rows);
  res.json({
    channels: rows.map((r) => ({
      id: r.id, type: r.type, target: r.target, label: r.label, events: r.events,
      active: r.active, lastError: r.last_error, lastSentAt: r.last_sent_at,
    })),
    availableEvents: notify.EVENTS,
  });
}));

// POST /channels  { type, target, label?, events? }
router.post('/channels', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const { type = 'telegram', target, label } = req.body || {};
  const events = (req.body && req.body.events) || ['payment.paid'];
  if (type !== 'telegram') return res.status(400).json({ error: 'unsupported_channel_type' });
  if (!target || !String(target).trim()) return res.status(400).json({ error: 'target_required' });
  const bad = events.filter((e) => !notify.EVENTS.includes(e));
  if (bad.length) return res.status(400).json({ error: 'unknown_event', detail: bad.join(',') });

  const row = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `INSERT INTO notification_channels (workspace_id, type, target, label, events, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (workspace_id, type, target) DO UPDATE SET events=EXCLUDED.events, label=EXCLUDED.label, active=true
     RETURNING id, type, target, label, events, active`,
    [wid(req), type, String(target).trim(), label || null, events, uid(req)])).rows[0]);
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'notification.channel.upsert', metadata: { type, target } });
  res.status(201).json(row);
}));

// PATCH /channels/:id  { active?, events? }
router.patch('/channels/:id', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const row = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    `UPDATE notification_channels
        SET active = COALESCE($2, active), events = COALESCE($3, events)
      WHERE id=$1 RETURNING id, type, target, events, active`,
    [req.params.id, b.active == null ? null : !!b.active, b.events || null])).rows[0]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
}));

// DELETE /channels/:id
router.delete('/channels/:id', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  await withWorkspace(wid(req), uid(req), (c) => c.query('DELETE FROM notification_channels WHERE id=$1', [req.params.id]));
  res.json({ ok: true });
}));

// POST /channels/:id/test — send a test message so the operator can verify setup
router.post('/channels/:id/test', requirePermission('settings.edit'), asyncHandler(async (req, res) => {
  const ch = await withWorkspace(wid(req), uid(req), async (c) => (await c.query(
    'SELECT id, type, target FROM notification_channels WHERE id=$1', [req.params.id])).rows[0]);
  if (!ch) return res.status(404).json({ error: 'not_found' });
  try {
    await notify.sendTelegram(ch.target, notify.renderTelegram({
      event: 'payment.paid', title: 'Test notification', body: 'If you can read this, HigherPays can reach this chat.',
    }));
    await withWorkspace(wid(req), uid(req), (c) => c.query('UPDATE notification_channels SET last_sent_at=now(), last_error=NULL WHERE id=$1', [ch.id]));
    res.json({ ok: true });
  } catch (e) {
    const detail = e.detail || e.message;
    await withWorkspace(wid(req), uid(req), (c) => c.query('UPDATE notification_channels SET last_error=$2 WHERE id=$1', [ch.id, String(detail).slice(0, 300)]));
    res.status(e.status || 502).json({ error: e.message, detail });
  }
}));

module.exports = router;
