'use strict';
const crypto = require('crypto');
const express = require('express');
const { query, withTransaction } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { badRequest } = require('../util/validate');
const { parseLimit, decodeCursor, page } = require('../lib/cursor');
const { resolveDataScope, scopeParams } = require('../auth/dataScope');
const { status: vocab } = require('../schema/entities');
const config = require('../config');
const provider = require('../providers/mantapay');
const linksService = require('../services/links.service');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');

const MIN_FIXED_AMOUNT = 3;             // provider minimum: 3 USD/EUR
const AGENT_RATE_WINDOW_SECONDS = 30;   // one link per agent per 30s

// A single-use link that went unpaid past its deadline reads as expired even
// though the column still says active; the reconciler writes it later.
const EFFECTIVE_STATUS = `CASE WHEN pl.status = 'active' AND pl.expires_at IS NOT NULL AND pl.expires_at < now()
                               THEN 'expired' ELSE pl.status END`;

const publicLink = (l) => ({
  id: l.id, type: l.type, pricingMode: l.pricing_mode,
  amount: l.amount == null ? null : Number(l.amount), currency: l.currency,
  status: l.status, referenceId: l.reference_id, description: l.description,
  checkoutUrl: l.checkout_url, expiresAt: l.expires_at, paidAt: l.paid_at, createdAt: l.created_at,
  accountId: l.account_id, account: l.account,
  agentId: l.created_by_agent_id, agent: l.agent,
});

// -----------------------------------------------------------------------------
// MantaPay hosted checkout. Card data never touches this server; the customer
// pays on MantaPay's page. The amount is baked into the signed URL.
// -----------------------------------------------------------------------------
async function generateProviderLink({ ws, currency, amount, referenceId, description, expiresAt }) {
  const notificationUrl = config.webhookPublicBase
    ? `${config.webhookPublicBase.replace(/\/$/, '')}/webhooks/payment/${ws.webhook_endpoint_id}`
    : undefined;
  const { checkoutUrl } = await provider.createCheckout(ws, {
    amount, currency, reference: referenceId, description, notificationUrl, expiresAt: expiresAt || undefined,
  });
  return checkoutUrl;
}

// What a caller may sort by. Not free text: the key picks the expression and
// the cast the cursor comparison. A link's amount is optional, so it sorts as
// zero rather than as NULL, which keyset pagination would drop.
// Mirrored in frontend/src/api/endpoints/links.ts.
const LINK_SORTS = {
  created: { expr: 'pl.created_at', cast: 'timestamptz', keyOf: (r) => r.created_at },
  amount: { expr: 'coalesce(pl.amount, 0)', cast: 'numeric', keyOf: (r) => r.amount ?? 0 },
  status: { expr: 'pl.effective_status', cast: 'text', keyOf: (r) => r.effective_status },
};

function sortFor(req) {
  const key = typeof req.query.sort === 'string' && LINK_SORTS[req.query.sort] ? req.query.sort : 'created';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  return { ...LINK_SORTS[key], dir, after: dir === 'ASC' ? '>' : '<' };
}

// GET /?limit&cursor&sort&dir&status&type&min&max&from&to&q&accountId
// Newest first by default. An agent sees the links they created; an owner the
// links against their account; everyone else the workspace. Filtering happens
// here, not in the browser: the list is cursor-paginated.
router.get('/', requirePermission('links.view'), asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const sort = sortFor(req);
  const cursor = decodeCursor(req.query.cursor);
  const num = (v) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const min = num(req.query.min), max = num(req.query.max);
  if (min != null && max != null && max < min) return badRequest(res, 'max must be >= min', ['min', 'max']);
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? `%${req.query.q.trim().toLowerCase()}%` : null;

  const rows = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);
    return (await c.query(
      `WITH effective AS (
         SELECT pl.*, ${EFFECTIVE_STATUS} AS effective_status FROM payment_links pl WHERE pl.workspace_id = $1
       )
       SELECT pl.*, pl.effective_status AS status,
              a.name AS account, u.full_name AS agent
         FROM effective pl
         JOIN accounts a ON a.id = pl.account_id
         LEFT JOIN agents ag ON ag.id = pl.created_by_agent_id
         LEFT JOIN users u ON u.id = ag.user_id
        WHERE ($2::uuid IS NULL OR pl.created_by_agent_id = $2::uuid)
          AND ($3::uuid IS NULL OR pl.account_id = $3::uuid)
          AND ($4::text IS NULL OR (${sort.expr}, pl.id) ${sort.after} ($4::${sort.cast}, $5::uuid))
          AND ($7::text IS NULL OR pl.effective_status = $7::text)
          AND ($8::text IS NULL OR pl.type = $8::text)
          AND ($9::numeric IS NULL OR pl.amount >= $9::numeric)
          AND ($10::numeric IS NULL OR pl.amount <= $10::numeric)
          AND ($11::timestamptz IS NULL OR pl.created_at >= $11::timestamptz)
          AND ($12::timestamptz IS NULL OR pl.created_at <= $12::timestamptz)
          AND ($13::uuid IS NULL OR pl.account_id = $13::uuid)
          AND ($14::text IS NULL OR lower(pl.reference_id) LIKE $14::text
               OR lower(u.full_name) LIKE $14::text)
        ORDER BY ${sort.expr} ${sort.dir}, pl.id ${sort.dir} LIMIT $6`,
      [wid(req), ...scopeParams(scope),
        cursor ? cursor.value : null, cursor ? cursor.id : null, limit + 1,
        req.query.status || null, req.query.type || null, min, max,
        req.query.from || null, req.query.to || null,
        req.query.accountId || null, q])).rows;
  });
  const result = page(rows, limit, sort.keyOf, (r) => r.id);
  res.json({ items: result.items.map(publicLink), nextCursor: result.nextCursor });
}));

// GET /:id
router.get('/:id', requirePermission('links.view'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);
    const row = (await c.query(
      `SELECT pl.*, ${EFFECTIVE_STATUS} AS status, a.name AS account, u.full_name AS agent
         FROM payment_links pl
         JOIN accounts a ON a.id = pl.account_id
         LEFT JOIN agents ag ON ag.id = pl.created_by_agent_id
         LEFT JOIN users u ON u.id = ag.user_id
        WHERE pl.workspace_id = $1 AND pl.id = $2
          AND ($3::uuid IS NULL OR pl.created_by_agent_id = $3::uuid)
          AND ($4::uuid IS NULL OR pl.account_id = $4::uuid)`,
      [wid(req), req.params.id, ...scopeParams(scope)])).rows[0];
    return row;
  });
  if (!out) return res.status(404).json({ error: 'not_found' });
  res.json(publicLink(out));
}));

// POST /  { accountId, type: 'single_use'|'reusable', amount, currency, description? }
// The customer is attached later, when the agent completes the payment's details.
router.post('/', requirePermission('links.create'), asyncHandler(async (req, res) => {
  const { accountId, type, amount, currency, description } = req.body || {};
  if (!accountId) return badRequest(res, 'accountId is required', ['accountId']);
  if (!vocab.LINK_TYPE.includes(type)) return badRequest(res, `type must be one of ${vocab.LINK_TYPE.join(', ')}`, ['type']);
  if (!/^[A-Za-z]{3}$/.test(currency || '')) return badRequest(res, 'currency must be a 3-letter code', ['currency']);
  const amt = Number(amount);
  if (!(amt > 0)) return badRequest(res, 'amount is required', ['amount']);
  if (amt < MIN_FIXED_AMOUNT) return badRequest(res, `minimum amount is ${MIN_FIXED_AMOUNT}`, ['amount']);
  const cur = currency.toUpperCase();
  if (!config.supportedCurrencies.includes(cur)) {
    return badRequest(res, `currency ${cur} is not enabled (supported: ${config.supportedCurrencies.join(', ')})`, ['currency']);
  }

  const ws = (await query('SELECT * FROM workspaces WHERE id = $1', [wid(req)])).rows[0];
  // Workspace guardrails, enforced here so the console cannot be bypassed.
  if (ws.min_link_amount != null && amt < Number(ws.min_link_amount)) {
    return badRequest(res, `amount is below the workspace minimum of ${Number(ws.min_link_amount)}`, ['amount']);
  }
  if (ws.max_link_amount != null && amt > Number(ws.max_link_amount)) {
    return badRequest(res, `amount is above the workspace maximum of ${Number(ws.max_link_amount)}`, ['amount']);
  }

  // The provider echoes this back as the attribution key; 64 random bits and a
  // UNIQUE index mean a collision cannot credit the wrong account.
  const referenceId = 'ord_' + crypto.randomBytes(8).toString('hex');
  const ttlMinutes = ws.link_ttl_minutes == null ? config.linkTtlMinutes : Number(ws.link_ttl_minutes);
  const expiresAt = type === 'single_use' ? new Date(Date.now() + ttlMinutes * 60_000) : null;

  const result = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);

    if (scope.kind === 'agent') {
      const recent = (await c.query(
        `SELECT created_at FROM payment_links
          WHERE workspace_id = $1 AND created_by_agent_id = $2 AND created_at > now() - ($3 || ' seconds')::interval
          ORDER BY created_at DESC LIMIT 1`, [wid(req), scope.agentId, AGENT_RATE_WINDOW_SECONDS])).rows[0];
      if (recent) {
        const elapsed = Math.floor((Date.now() - new Date(recent.created_at).getTime()) / 1000);
        return { rateLimited: Math.max(1, AGENT_RATE_WINDOW_SECONDS - elapsed) };
      }
    }

    // The account must be active, in this workspace and, for an agent, one
    // they are assigned. An unassigned account reports the same not-found as a
    // nonexistent one, so this is not an existence oracle.
    const account = (await c.query(
      `SELECT id FROM accounts a
        WHERE a.id = $1 AND a.workspace_id = $2 AND a.status = 'active'
          AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM account_agents ag WHERE ag.account_id = a.id AND ag.agent_id = $3::uuid))`,
      [accountId, wid(req), scope.kind === 'agent' ? scope.agentId : null])).rows[0];
    if (!account) return { err: 'account_not_found' };

    // HigherPays' own fee, paid by the customer on top of the price. Copied
    // onto the link so a later rate change cannot rewrite what this customer
    // was charged, and never part of the amount the agency is credited.
    const card = (await c.query('SELECT checkout_fee FROM effective_platform_fee($1, now())', [wid(req)])).rows[0];
    const checkoutFee = Number(card?.checkout_fee || 0);

    const checkoutUrl = await generateProviderLink({
      ws, currency: cur, amount: amt + checkoutFee, referenceId, description, expiresAt,
    });

    const link = (await c.query(
      `INSERT INTO payment_links
         (workspace_id, account_id, created_by_agent_id, type, pricing_mode, amount, checkout_fee, currency,
          status, reference_id, provider_link_id, description, expires_at, checkout_url)
       VALUES ($1,$2,$3,$4,'fixed',$5,$6,$7,'active',$8,$8,$9,$10,$11)
       RETURNING *`,
      [wid(req), accountId, scope.kind === 'agent' ? scope.agentId : null,
        type, amt, checkoutFee, cur, referenceId, description || null, expiresAt, checkoutUrl])).rows[0];
    return { link };
  });

  if (result.rateLimited) {
    res.setHeader('Retry-After', String(result.rateLimited));
    return res.status(429).json({ error: 'rate_limited', scope: 'agent', retryAfterSeconds: result.rateLimited });
  }
  if (result.err) return res.status(404).json({ error: result.err });

  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'link.create', entityType: 'payment_link', entityId: result.link.id, metadata: { type, amount: amt, currency: cur } });
  res.status(201).json(publicLink(result.link));
}));

// POST /:id/cancel — close a link by hand. Only an unpaid one; a paid link is
// history, not something to withdraw.
router.post('/:id/cancel', requirePermission('links.create'), asyncHandler(async (req, res) => {
  const out = await withTransaction(async (c) => {
    const scope = await resolveDataScope(c, req);
    const row = (await c.query(
      `UPDATE payment_links SET status = 'cancelled'
        WHERE workspace_id = $1 AND id = $2 AND status = 'active'
          AND ($3::uuid IS NULL OR created_by_agent_id = $3::uuid)
          AND ($4::uuid IS NULL OR account_id = $4::uuid)
        RETURNING *`, [wid(req), req.params.id, ...scopeParams(scope)])).rows[0];
    return row;
  });
  if (!out) return res.status(404).json({ error: 'not_found_or_not_active' });
  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'link.cancel', entityType: 'payment_link', entityId: out.id });
  res.json(publicLink(out));
}));

// GET /:id/impact — what reassigning this link would move. Read before the
// confirmation, so the dialog can say it in numbers rather than in general.
router.get('/:id/impact', requirePermission('revenue.manage'), asyncHandler(async (req, res) => {
  const row = (await query(`
    SELECT count(*)::int AS payments,
           count(*) FILTER (WHERE re.account_payout_id IS NOT NULL OR re.agent_payout_id IS NOT NULL)::int AS paid_out,
           COALESCE(SUM(p.amount), 0) AS amount
      FROM payments p
      LEFT JOIN transactions t ON t.payment_id = p.id AND t.type = 'payment'
      LEFT JOIN revenue_entries re ON re.transaction_id = t.id AND re.entry_type = 'sale'
     WHERE p.workspace_id = $1 AND p.payment_link_id = $2`, [wid(req), req.params.id])).rows[0];
  res.json({ payments: row.payments, paidOut: row.paid_out, amount: Number(row.amount) });
}));

// PATCH /:id/attribution  { accountId?, agentId? }
// Moves a link, and everything already taken on it, to another creator or
// agent. The ledger is rewritten: each sale is re-posted against the new
// attribution, so a payout that already paid the old creator for one of these
// payments is left overpaid — /impact says how many before confirming.
router.patch('/:id/attribution', requirePermission('revenue.manage'), asyncHandler(async (req, res) => {
  const { accountId, agentId } = req.body || {};
  if (accountId === undefined && agentId === undefined) {
    return badRequest(res, 'accountId or agentId is required', ['accountId', 'agentId']);
  }

  const out = await withTransaction(async (c) => {
    const link = (await c.query(
      'SELECT * FROM payment_links WHERE workspace_id = $1 AND id = $2', [wid(req), req.params.id])).rows[0];
    if (!link) return { notFound: true };

    const nextAccountId = accountId === undefined ? link.account_id : accountId;
    const nextAgentId = agentId === undefined ? link.created_by_agent_id : (agentId || null);

    const account = (await c.query(
      "SELECT id FROM accounts WHERE id = $1 AND workspace_id = $2 AND status <> 'archived'",
      [nextAccountId, wid(req)])).rows[0];
    if (!account) return { err: 'account_not_found', fields: ['accountId'] };

    if (nextAgentId) {
      const agent = (await c.query(
        'SELECT id FROM agents WHERE id = $1 AND workspace_id = $2', [nextAgentId, wid(req)])).rows[0];
      if (!agent) return { err: 'agent_not_found', fields: ['agentId'] };
      const assigned = (await c.query(
        'SELECT 1 FROM account_agents WHERE account_id = $1 AND agent_id = $2', [nextAccountId, nextAgentId])).rows[0];
      if (!assigned) return { err: 'agent_not_assigned_to_account', fields: ['agentId'] };
    }

    await c.query(
      'UPDATE payment_links SET account_id = $2, created_by_agent_id = $3 WHERE id = $1',
      [link.id, nextAccountId, nextAgentId]);
    const moved = await c.query(
      'UPDATE payments SET account_id = $2, agent_id = $3 WHERE payment_link_id = $1',
      [link.id, nextAccountId, nextAgentId]);

    // Re-post every sale on this link. Deleting first is what makes it a
    // rewrite: the new entries are unpaid, whatever the old ones had settled.
    const sales = (await c.query(`
      SELECT t.id FROM transactions t
       WHERE t.payment_id IN (SELECT id FROM payments WHERE payment_link_id = $1)
         AND t.type = 'payment' AND t.status = 'approved'`, [link.id])).rows;
    for (const t of sales) {
      await c.query("DELETE FROM revenue_entries WHERE transaction_id = $1 AND entry_type = 'sale'", [t.id]);
      await c.query('SELECT fn_post_sale($1)', [t.id]);
    }

    return {
      link: (await c.query(`
        SELECT pl.*, ${EFFECTIVE_STATUS} AS status, a.name AS account, u.full_name AS agent
          FROM payment_links pl
          JOIN accounts a ON a.id = pl.account_id
          LEFT JOIN agents ag ON ag.id = pl.created_by_agent_id
          LEFT JOIN users u ON u.id = ag.user_id
         WHERE pl.id = $1`, [link.id])).rows[0],
      moved: moved.rowCount,
      reposted: sales.length,
      from: { accountId: link.account_id, agentId: link.created_by_agent_id },
    };
  });

  if (out.notFound) return res.status(404).json({ error: 'not_found' });
  if (out.err) return badRequest(res, out.err, out.fields);
  await audit({
    workspaceId: wid(req), actorUserId: uid(req), action: 'link.reassign',
    entityType: 'payment_link', entityId: req.params.id,
    metadata: {
      from: out.from,
      to: { accountId: out.link.account_id, agentId: out.link.created_by_agent_id },
      payments: out.moved, reposted: out.reposted,
    },
  });
  res.json({ ...publicLink(out.link), moved: out.moved, reposted: out.reposted });
}));

// POST /reconcile — the same reconciliation the server runs on a timer, on
// demand. Kept for support: nobody has to wait for the next pass.
router.post('/reconcile', requirePermission('revenue.manage'), asyncHandler(async (req, res) => {
  const requested = Number(req.body && req.body.graceMinutes);
  const graceMin = Number.isFinite(requested) && requested >= 0 ? requested : linksService.DEFAULT_GRACE_MINUTES;
  const ws = (await query('SELECT * FROM workspaces WHERE id=$1', [wid(req)])).rows[0];
  const summary = await withTransaction((c) => linksService.reconcileWorkspace(c, ws, graceMin));
  res.json(summary);
}));

module.exports = router;
