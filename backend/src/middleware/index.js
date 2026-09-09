'use strict';
const { verifyAccessToken } = require('../auth/tokens');
const { hasPermission } = require('../auth/permissions');
const { query } = require('../db');
const { asyncHandler } = require('../lib/http');
const { log } = require('../lib/log');
const {
  HttpError, UnauthorizedError, ForbiddenError, BadRequestError,
} = require('../lib/errors');

// 1) requireAuth — validates the bearer token, attaches req.user.
const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(new UnauthorizedError('missing_token'));
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return next(new UnauthorizedError('invalid_token'));
  }

  if (payload.impersonation === true) {
    if (!payload.jti || !payload.actor || !payload.workspace) {
      return next(new UnauthorizedError('invalid_token'));
    }
    const active = (await query(
      `SELECT 1 FROM impersonation_sessions
        WHERE jti=$1 AND actor_user_id=$2 AND subject_user_id=$3 AND workspace_id=$4
          AND revoked_at IS NULL AND expires_at > now()`,
      [payload.jti, payload.actor, payload.sub, payload.workspace])).rows[0];
    if (!active) return next(new UnauthorizedError('invalid_token'));
  }

  req.user = {
    id: payload.sub,
    email: payload.email,
    name: payload.name,
    sessionId: payload.sid || null,
    twoFactorAuthenticated: payload.mfa === true,
    actorId: payload.impersonation === true ? payload.actor : null,
    impersonationJti: payload.impersonation === true ? payload.jti : null,
    impersonationWorkspaceId: payload.impersonation === true ? payload.workspace : null,
    impersonatedRole: payload.impersonation === true ? payload.role : null,
  };
  next();
});

// 2) requireWorkspace — resolves the workspace from the X-Workspace-Id header
// (or the URL), confirms the caller has ACTIVE access to it, and attaches
// req.access = { workspaceId, role, permissions }. Every workspace query after
// this filters on req.access.workspaceId.
const requireWorkspace = asyncHandler(async (req, _res, next) => {
  const fromHeader = req.headers['x-workspace-id'];
  const fromPath = req.params.workspaceId;
  if (fromHeader && fromPath && fromHeader !== fromPath) throw new BadRequestError('workspace_mismatch');
  const workspaceId = fromHeader || fromPath;
  if (!workspaceId) throw new BadRequestError('missing_workspace');
  if (req.user.impersonationWorkspaceId && req.user.impersonationWorkspaceId !== workspaceId) {
    throw new ForbiddenError('impersonation_workspace_mismatch');
  }

  const row = (await query(
    `SELECT wu.role,
            CASE wu.role
              WHEN 'agent' THEN w.agent_label
              WHEN 'account_owner' THEN w.account_label || ' owner'
              ELSE wr.name
            END AS role_name,
            wr.permissions
       FROM workspace_users wu
       JOIN workspace_roles wr ON wr.workspace_id=wu.workspace_id AND wr.key=wu.role
       JOIN workspaces w ON w.id=wu.workspace_id
      WHERE wu.workspace_id = $1 AND wu.user_id = $2 AND wu.status = 'active'`,
    [workspaceId, req.user.id])).rows[0];
  if (!row) throw new ForbiddenError('not_a_member');

  req.access = {
    workspaceId,
    role: row.role,
    roleName: row.role_name,
    permissions: new Set(row.permissions),
  };
  if (req.user.actorId) {
    await query(
      `INSERT INTO audit_log
         (workspace_id, actor_user_id, effective_user_id, action, entity_type, entity_id, metadata, ip)
       VALUES ($1,$2,$3,'platform.impersonation.request','user',$3,$4,$5)`,
      [workspaceId, req.user.actorId, req.user.id, {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        jti: req.user.impersonationJti,
      }, req.ip || null]);
  }
  next();
});

// 3) requirePermission — gate a handler on one permission string. This answers
// "may you call this endpoint"; which ROWS come back is resolveDataScope's job.
const requirePermission = (permission) => (req, _res, next) => {
  if (!req.access) return next(new HttpError(500, 'workspace_context_missing'));
  if (!hasPermission(req.access, permission)) {
    return next(new ForbiddenError('forbidden', 'permission required', { needed: permission }));
  }
  next();
};

// 4) requirePlatformAdmin — HigherPays operator gate, above any single workspace.
const requirePlatformAdmin = asyncHandler(async (req, _res, next) => {
  if (req.user.actorId) throw new ForbiddenError('impersonation_platform_forbidden');
  const { rows } = await query(
    'SELECT is_platform_admin, two_factor_enabled FROM users WHERE id = $1',
    [req.user.id]);
  if (!rows[0] || !rows[0].is_platform_admin) throw new ForbiddenError('not_platform_admin');
  if (!rows[0].two_factor_enabled || !req.user.twoFactorAuthenticated) {
    throw new ForbiddenError('platform_two_factor_required');
  }
  next();
});

// 5) errorHandler — last middleware. Formats HttpError instances into the
// canonical response envelope; unknown errors are logged and returned as 500.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof HttpError) {
    if (err.status === 429) (req.log || log).warn({ code: err.code, ip: req.ip }, 'rate limited');
    return res.status(err.status).json(err.toJSON());
  }

  // Provider adapters throw plain errors with .status/.code set.
  const status = err.status || err.statusCode || 500;
  const code = err.code || 'server_error';
  const logger = req.log || log;
  if (status >= 500) {
    logger.error({ err: err.stack || err.message, code }, 'unhandled error');
  } else {
    logger.warn({ code, message: err.message }, 'request failed');
  }
  // Internal details stay in the log; the client gets the request id to quote.
  res.status(status).json(status >= 500
    ? { error: code, message: 'Something went wrong on our side.', requestId: req.id }
    : { error: code, message: err.message });
}

module.exports = { requireAuth, requireWorkspace, requirePermission, requirePlatformAdmin, errorHandler };
