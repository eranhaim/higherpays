'use strict';
const express = require('express');
const path = require('path');
const config = require('./config');
const { pool, withSystem, withPlatformAdmin } = require('./db');
const { log, requestLogger } = require('./lib/log');
const authRoutes = require('./routes/auth.routes');
const accountsRoutes = require('./routes/accounts.routes');
const customersRoutes = require('./routes/customers.routes');
const linksRoutes = require('./routes/links.routes');
const commissionsRoutes = require('./routes/commissions.routes');
const platformRoutes = require('./routes/platform.routes');
const payoutsRoutes = require('./routes/payouts.routes');
const rolesRoutes = require('./routes/roles.routes');
const workspaceRoutes = require('./routes/workspace.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const targetsRoutes = require('./routes/targets.routes');
const membershipsRoutes = require('./routes/memberships.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const settlementsRoutes = require('./routes/settlements.routes');
const feesRoutes = require('./routes/fees.routes');
const meRoutes = require('./routes/me.routes');
const webhooksRoutes = require('./routes/webhooks.routes');
const { wsRouter: invitesWsRoutes, publicRouter: invitesPublicRoutes } = require('./routes/invites.routes');
const { requireAuth, requireWorkspace, requirePermission, requirePlatformAdmin, errorHandler } = require('./middleware');
const { asyncHandler } = require('./lib/http');
const { ROLE_PERMISSIONS, seedRolesForWorkspace } = require('./auth/permissions');
const { audit } = require('./util/audit');

const app = express();

// One reverse proxy (the EC2 nginx) sits in front; trust its X-Forwarded-* so
// req.ip and req.protocol describe the client, not the proxy.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(requestLogger);

// The API only ever returns JSON; these headers stop a browser treating a
// response as anything else, or framing it.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// CORS — only the origins we serve the console from. Same-origin requests
// (production, via the nginx /api proxy) carry no Origin and pass untouched.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Workspace-Id, X-Request-Id');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Webhooks receive a raw body (needed for signature verification), so they are
// mounted BEFORE the JSON parser.
app.use('/webhooks', express.raw({ type: '*/*', limit: '1mb' }), webhooksRoutes);

app.use(express.json({ limit: '8mb' }));

// Static assets (favicons, provider callback pages, etc.). The React frontend
// lives in ../frontend and is served separately (Vite in dev, nginx in prod).
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health reports on the database too: a green health check with Postgres down
// hides the only failure that matters. Unprocessed webhooks older than an hour
// mean a payment exists at the provider and not in the ledger.
app.get('/health', asyncHandler(async (req, res) => {
  try {
    // webhook_events is tenant-scoped; the health check counts across tenants.
    const { rows } = await withSystem((c) => c.query(
      "SELECT count(*)::int AS stale FROM webhook_events WHERE processed = false AND signature_valid = true AND received_at < now() - interval '1 hour'"));
    const staleWebhooks = rows[0].stale;
    res.status(staleWebhooks ? 503 : 200).json({ ok: staleWebhooks === 0, env: config.env, db: 'up', staleWebhooks });
  } catch (e) {
    req.log.error({ err: e.message }, 'health: database check failed');
    res.status(503).json({ ok: false, env: config.env, db: 'down' });
  }
}));

app.use('/auth', authRoutes);

// Platform (Super-Admin) — HigherPays operator, above any single tenant.
app.use('/platform', requireAuth, requirePlatformAdmin, platformRoutes);

// POST /workspaces — a second brand/MID under the SAME organization. No
// :workspaceId in the path: requireWorkspace resolves the source workspace from
// X-Workspace-Id, and that is what identifies the organization to add to.
// Runs in platform context like /auth/register does, because the new
// workspace's RLS row does not admit the caller until the membership lands.
app.post('/workspaces', requireAuth, requireWorkspace, requirePermission('workspaces.create'),
  asyncHandler(async (req, res) => {
    const name = req.body && req.body.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 120) {
      return res.status(400).json({ error: 'validation_failed', message: 'name is required' });
    }
    const currency = String((req.body && req.body.currency) || 'EUR').toUpperCase();
    if (!config.supportedCurrencies.includes(currency)) {
      return res.status(400).json({ error: 'validation_failed', message: `currency ${currency} is not enabled` });
    }

    const created = await withPlatformAdmin(req.user.id, async (c) => {
      const org = (await c.query(
        'SELECT organization_id FROM workspaces WHERE id = $1', [req.membership.workspaceId])).rows[0];
      const ws = (await c.query(
        `INSERT INTO workspaces (organization_id, name, currency, provider_name)
         VALUES ($1,$2,$3,'mantapay') RETURNING id, name, currency, webhook_endpoint_id`,
        [org.organization_id, name.trim(), currency])).rows[0];
      await c.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
        [ws.id, req.user.id]);
      await seedRolesForWorkspace(c, ws.id);
      return ws;
    });

    await audit({
      workspaceId: created.id, actorUserId: req.user.id, action: 'workspace.create',
      entityType: 'workspace', entityId: created.id, metadata: { name: created.name },
    });
    res.status(201).json({
      id: created.id, name: created.name, currency: created.currency,
      webhookEndpointId: created.webhook_endpoint_id,
    });
  }));

// Every workspace-scoped router runs behind auth + membership resolution.
// Individual routes inside then gate on specific permissions.
app.use('/workspaces/:workspaceId/accounts', requireAuth, requireWorkspace, accountsRoutes);
app.use('/workspaces/:workspaceId/customers', requireAuth, requireWorkspace, customersRoutes);
app.use('/workspaces/:workspaceId/links', requireAuth, requireWorkspace, linksRoutes);
app.use('/workspaces/:workspaceId/commissions', requireAuth, requireWorkspace, commissionsRoutes);
app.use('/workspaces/:workspaceId', requireAuth, requireWorkspace, payoutsRoutes);
app.use('/workspaces/:workspaceId/roles', requireAuth, requireWorkspace, rolesRoutes);
app.use('/workspaces/:workspaceId/analytics', requireAuth, requireWorkspace, analyticsRoutes);
app.use('/workspaces/:workspaceId/targets', requireAuth, requireWorkspace, targetsRoutes);
app.use('/workspaces/:workspaceId/memberships', requireAuth, requireWorkspace, membershipsRoutes);
app.use('/workspaces/:workspaceId/notifications', requireAuth, requireWorkspace, notificationsRoutes);
app.use('/workspaces/:workspaceId/settlements', requireAuth, requireWorkspace, settlementsRoutes);
app.use('/workspaces/:workspaceId/fees', requireAuth, requireWorkspace, feesRoutes);
app.use('/workspaces/:workspaceId/me', requireAuth, requireWorkspace, meRoutes);
app.use('/workspaces/:workspaceId', requireAuth, requireWorkspace, workspaceRoutes);
app.use('/workspaces/:workspaceId/invites', invitesWsRoutes);
app.use('/invites', invitesPublicRoutes);

// Effective permissions for the current user in a workspace (used by the UI).
app.get('/workspaces/:workspaceId/permissions',
  requireAuth, requireWorkspace,
  asyncHandler(async (req, res) => {
    res.json({
      workspaceId: req.membership.workspaceId,
      role: req.membership.role,
      permissions: req.membership.permissions ? [...req.membership.permissions] : [...(ROLE_PERMISSIONS[req.membership.role] || [])],
    });
  })
);

app.use(errorHandler);

// A superuser (or a BYPASSRLS role) ignores every RLS policy, so tenant isolation
// would be silently off even with USE_RLS=true. Verify the DB role at boot.
async function assertRlsEffective() {
  if (!config.useRls) return;
  const { rows } = await pool.query(
    "SELECT current_setting('is_superuser') = 'on' AS superuser, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  const r = rows[0] || {};
  if (r.superuser || r.rolbypassrls) {
    const msg = `DB role "${process.env.PGUSER || 'app'}" bypasses RLS (superuser=${!!r.superuser}, bypassrls=${!!r.rolbypassrls}). Tenant isolation would NOT be enforced.`;
    if (config.env === 'production') throw new Error(msg);
    log.warn(msg);
  } else {
    log.info('RLS active and the DB role is subject to it');
  }
}

if (require.main === module) {
  assertRlsEffective().catch((e) => {
    log.error({ err: e.message }, 'startup check failed');
    if (config.env === 'production') process.exit(1);
  });

  for (const i of config.integrations) {
    log.info({ integration: i.name, enabled: i.enabled, needs: i.enabled ? undefined : i.needs }, 'integration');
  }

  app.listen(config.port, () => log.info({ port: config.port }, 'HigherPays API listening'));
}

module.exports = app;
