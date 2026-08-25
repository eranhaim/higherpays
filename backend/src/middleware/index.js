'use strict';
const { verifyAccessToken } = require('../auth/tokens');
const { can, PERMISSIONS } = require('../auth/permissions');
const { query, withUser } = require('../db');
const { asyncHandler } = require('../lib/http');
const {
  HttpError, UnauthorizedError, ForbiddenError, BadRequestError,
} = require('../lib/errors');

// 1) requireAuth — validates the bearer token, attaches req.user.
const requireAuth = (req, _res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(new UnauthorizedError('missing_token'));
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email, name: payload.name };
    next();
  } catch {
    next(new UnauthorizedError('invalid_token'));
  }
};

// 2) requireWorkspace — resolves the active workspace from the X-Workspace-Id
// header (or the URL slug), confirms the caller has an ACTIVE membership, and
// attaches req.membership = { id, workspaceId, role, permissions }.
// Platform super-admins get synthetic full-permission membership on any
// workspace; RLS still scopes reads/writes to that workspace via withWorkspace.
const requireWorkspace = asyncHandler(async (req, _res, next) => {
  const workspaceId = req.headers['x-workspace-id'] || req.params.workspaceId;
  if (!workspaceId) throw new BadRequestError('missing_workspace');

  const rows = await withUser(req.user.id, (c) => c.query(
    `SELECT m.id, m.role, r.permissions
     FROM memberships m
     LEFT JOIN roles r ON r.workspace_id = m.workspace_id AND r.name = m.role
     WHERE m.workspace_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
    [workspaceId, req.user.id]).then((r) => r.rows));

  if (rows.length === 0) {
    const pa = (await query('SELECT role FROM platform_admins WHERE user_id = $1', [req.user.id])).rows[0];
    if (pa && pa.role === 'super_admin') {
      req.membership = {
        id: null, workspaceId, role: 'super_admin',
        permissions: new Set(PERMISSIONS), isPlatformOperator: true,
      };
      return next();
    }
    throw new ForbiddenError('not_a_member');
  }
  req.membership = {
    id: rows[0].id,
    workspaceId,
    role: rows[0].role,
    permissions: rows[0].permissions ? new Set(rows[0].permissions) : null,
  };
  next();
});

// 3) requirePermission — gate a handler on a specific permission string. Prefers
// the workspace's editable role definition; falls back to the built-in matrix.
// `settings.danger` is what separates owner from admin, so it is tied to the
// owner role itself rather than to any editable permission list.
const requirePermission = (permission) => (req, _res, next) => {
  if (!req.membership) return next(new HttpError(500, 'workspace_context_missing'));
  const ownerOnly = permission === 'settings.danger'
    && req.membership.role !== 'owner' && !req.membership.isPlatformOperator;
  const ok = !ownerOnly && (req.membership.permissions
    ? req.membership.permissions.has(permission)
    : can(req.membership.role, permission));
  if (!ok) return next(new ForbiddenError('forbidden', 'permission required', { needed: permission }));
  next();
};

// 4) requirePlatformAdmin — HigherPays operator gate, above any single tenant.
const requirePlatformAdmin = asyncHandler(async (req, _res, next) => {
  const { rows } = await query('SELECT role FROM platform_admins WHERE user_id = $1', [req.user.id]);
  if (rows.length === 0) throw new ForbiddenError('not_platform_admin');
  req.platformRole = rows[0].role;
  next();
});

// 4b) requirePlatformRole — narrows a platform route to specific platform
// roles. Mount after requirePlatformAdmin, which sets req.platformRole.
const requirePlatformRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.platformRole)) {
    return next(new ForbiddenError('insufficient_platform_role', 'platform role required', { needed: roles }));
  }
  next();
};

// 5) errorHandler — last middleware. Formats HttpError instances into the
// canonical response envelope; unknown errors are logged and returned as 500.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof HttpError) {
    return res.status(err.status).json(err.toJSON());
  }

  // Legacy shape: some throws still set .status/.code themselves (e.g. provider
  // adapters). Honour them, but don't pretend they're safe error surfaces.
  const status = err.status || err.statusCode || 500;
  const code = err.code || 'server_error';
  if (status >= 500) {
    console.error('[error]', err.stack || err.message);
  } else {
    console.warn(`[${code}]`, err.message);
  }
  res.status(status).json({ error: code, message: err.message });
}

module.exports = {
  requireAuth, requireWorkspace, requirePermission, requirePlatformAdmin, requirePlatformRole,
  errorHandler,
};
