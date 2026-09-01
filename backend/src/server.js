'use strict';
const express = require('express');
const path = require('path');
const config = require('./config');
const { query } = require('./db');
const { log, requestLogger } = require('./lib/log');
const authRoutes = require('./routes/auth.routes');
const accountsRoutes = require('./routes/accounts.routes');
const agentsRoutes = require('./routes/agents.routes');
const categoriesRoutes = require('./routes/categories.routes');
const customersRoutes = require('./routes/customers.routes');
const linksRoutes = require('./routes/links.routes');
const paymentsRoutes = require('./routes/payments.routes');
const revenueRoutes = require('./routes/revenue.routes');
const platformRoutes = require('./routes/platform.routes');
const payoutsRoutes = require('./routes/payouts.routes');
const workspaceRoutes = require('./routes/workspace.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const teamRoutes = require('./routes/team.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const settlementsRoutes = require('./routes/settlements.routes');
const feesRoutes = require('./routes/fees.routes');
const meRoutes = require('./routes/me.routes');
const webhooksRoutes = require('./routes/webhooks.routes');
const { wsRouter: invitesWsRoutes, publicRouter: invitesPublicRoutes } = require('./routes/invites.routes');
const { startReconcileLoop } = require('./services/links.service');
const { requireAuth, requireWorkspace, requirePlatformAdmin, errorHandler } = require('./middleware');
const { asyncHandler } = require('./lib/http');

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

app.use(express.static(path.join(__dirname, '..', 'public')));

// Health reports on the database too: a green health check with Postgres down
// hides the only failure that matters. Unprocessed webhooks older than an hour
// mean a payment exists at the provider and not in the ledger.
app.get('/health', asyncHandler(async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT count(*)::int AS stale FROM webhook_events WHERE processed = false AND signature_valid = true AND received_at < now() - interval '1 hour'");
    const staleWebhooks = rows[0].stale;
    res.status(staleWebhooks ? 503 : 200).json({ ok: staleWebhooks === 0, env: config.env, db: 'up', staleWebhooks });
  } catch (e) {
    req.log.error({ err: e.message }, 'health: database check failed');
    res.status(503).json({ ok: false, env: config.env, db: 'down' });
  }
}));

app.use('/auth', authRoutes);

// The operator console, above any single workspace.
app.use('/platform', requireAuth, requirePlatformAdmin, platformRoutes);

// Every workspace router runs behind auth + access resolution. Routes inside
// then gate on specific permissions.
const ws = [requireAuth, requireWorkspace];
app.use('/workspaces/:workspaceId/accounts', ws, accountsRoutes);
app.use('/workspaces/:workspaceId/agents', ws, agentsRoutes);
app.use('/workspaces/:workspaceId/categories', ws, categoriesRoutes);
app.use('/workspaces/:workspaceId/customers', ws, customersRoutes);
app.use('/workspaces/:workspaceId/links', ws, linksRoutes);
app.use('/workspaces/:workspaceId/payments', ws, paymentsRoutes);
app.use('/workspaces/:workspaceId/revenue', ws, revenueRoutes);
app.use('/workspaces/:workspaceId/payouts', ws, payoutsRoutes);
app.use('/workspaces/:workspaceId/analytics', ws, analyticsRoutes);
app.use('/workspaces/:workspaceId/team', ws, teamRoutes);
app.use('/workspaces/:workspaceId/notifications', ws, notificationsRoutes);
app.use('/workspaces/:workspaceId/settlements', ws, settlementsRoutes);
app.use('/workspaces/:workspaceId/fees', ws, feesRoutes);
app.use('/workspaces/:workspaceId/me', ws, meRoutes);
app.use('/workspaces/:workspaceId/invites', invitesWsRoutes);
app.use('/invites', invitesPublicRoutes);

// Effective permissions for the current user in a workspace (used by the UI).
app.get('/workspaces/:workspaceId/permissions', ws, (req, res) => {
  res.json({ workspaceId: req.access.workspaceId, role: req.access.role, permissions: [...req.access.permissions] });
});

app.use('/workspaces/:workspaceId', ws, workspaceRoutes);

app.use(errorHandler);

if (require.main === module) {
  for (const i of config.integrations) {
    log.info({ integration: i.name, enabled: i.enabled, needs: i.enabled ? undefined : i.needs }, 'integration');
  }
  app.listen(config.port, () => log.info({ port: config.port }, 'HigherPays API listening'));
  // A payment whose webhook never arrived is invisible until someone asks the
  // provider. Nobody should have to press a button for that.
  startReconcileLoop();
}

module.exports = app;
