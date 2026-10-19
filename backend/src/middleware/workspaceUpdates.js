'use strict';

const { query } = require('../db');
const { log } = require('../lib/log');
const { publishWorkspaceUpdate } = require('../events/workspaceEvents');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function publishAfterResponse(req, workspaceIds, res) {
  if (!MUTATING_METHODS.has(req.method)) return;
  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    for (const workspaceId of workspaceIds) publishWorkspaceUpdate(workspaceId);
  });
}

function publishWorkspaceUpdateAfterResponse(req, res, next) {
  publishAfterResponse(req, req.access?.workspaceId ? [req.access.workspaceId] : [], res);
  next();
}

function publishPlatformUpdatesAfterResponse(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    query("SELECT id FROM workspaces WHERE status = 'active'")
      .then(({ rows }) => rows.forEach((workspace) => publishWorkspaceUpdate(workspace.id)))
      .catch((error) => log.error({ err: error.message }, 'workspace update publish failed'));
  });
  next();
}

module.exports = { publishWorkspaceUpdateAfterResponse, publishPlatformUpdatesAfterResponse };
