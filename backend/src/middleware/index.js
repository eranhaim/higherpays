'use strict';
const { verifyAccessToken } = require('../auth/tokens');
const { ROLE_PERMISSIONS, hasPermission } = require('../auth/permissions');
const { query } = require('../db');
const { asyncHandler } = require('../lib/http');
const { log } = require('../lib/log');
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
    req.user = { id: payload.sub, email: payload.email, name: payload.name, sessionId: payload.sid || null };
    next();
  } catch {
    next(new UnauthorizedError('invalid_token'));
  }
};

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

  const row = (await query(
    `SELECT role FROM workspace_users
      WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
    [workspaceId, req.user.id])).rows[0];
  if (!row) throw new ForbiddenError('not_a_member');

  req.access = { workspaceId, role: row.role, permissions: ROLE_PERMISSIONS[row.role] };
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
  const { rows } = await query('SELECT is_platform_admin FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0] || !rows[0].is_platform_admin) throw new ForbiddenError('not_platform_admin');
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
