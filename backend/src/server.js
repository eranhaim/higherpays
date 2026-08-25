'use strict';
const express = require('express');
const path = require('path');
const config = require('./config');
const { pool } = require('./db');
const { log, requestLogger } = require('./lib/log');
const authRoutes = require('./routes/auth.routes');
const creatorsRoutes = require('./routes/creators.routes');
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
const { requireAuth, requireWorkspace, requirePlatformAdmin, errorHandler } = require('./middleware');
const { asyncHandler } = require('./lib/http');
const { ROLE_PERMISSIONS } = require('./auth/permissions');

const app = express();

// One reverse proxy (the EC2 nginx) sits in front; trust its X-Forwarded-* so
// req.ip and req.protocol describe the client, not the proxy.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(requestLogger);

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
    const { rows } = await pool.query(
      "SELECT count(*)::int AS stale FROM webhook_events WHERE processed = false AND signature_valid = true AND created_at < now() - interval '1 hour'");
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

// Every workspace-scoped router runs behind auth + membership resolution.
// Individual routes inside then gate on specific permissions.
app.use('/workspaces/:workspaceId/creators', requireAuth, requireWorkspace, creatorsRoutes);
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
