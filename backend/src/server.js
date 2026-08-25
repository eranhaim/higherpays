'use strict';
const express = require('express');
const config = require('./config');
const { pool } = require('./db');
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
const { wsRouter: invitesWsRoutes, publicRouter: invitesPublicRoutes } = require('./routes/invites.routes');
const { requireAuth, requireWorkspace, requirePermission, requirePlatformAdmin, errorHandler } = require('./middleware');
const { asyncHandler } = require('./util/audit');
const { ROLE_PERMISSIONS } = require('./auth/permissions');

const app = express();
const path = require('path');

// CORS — lets the browser console (served from any origin) call the API.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Workspace-Id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Webhooks receive a raw body (needed for signature verification), so they are
// mounted BEFORE the JSON parser.
const webhooksRoutes = require('./routes/webhooks.routes');
app.use('/webhooks', express.raw({ type: '*/*', limit: '1mb' }), webhooksRoutes);

app.use(express.json({ limit: '20mb' }));

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
    console.error('[health] database check failed:', e.message);
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

if (require.main === module) {
  
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
    console.warn('[startup] WARNING: ' + msg);
  } else {
    console.log('[startup] RLS active and the DB role is subject to it.');
  }
}

assertRlsEffective().catch((e) => { console.error('[startup] ' + e.message); if (config.env === 'production') process.exit(1); });

for (const i of config.integrations) {
  console.log(`[startup] ${i.name}: ${i.enabled ? 'enabled' : `disabled (set ${i.needs})`}`);
}

app.listen(config.port, () => console.log(`HigherPays API on :${config.port} (${config.env})`));
}

module.exports = app;
