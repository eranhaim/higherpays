'use strict';
const { query } = require('../db');
const { log } = require('../lib/log');
// Re-export from lib/http for backwards compatibility with existing route
// files that do `require('../util/audit').asyncHandler`.
const { asyncHandler } = require('../lib/http');

// Append an entry to the audit log. Best-effort: never block the request path
// on an audit write failure, but do log it.
async function audit({ workspaceId = null, actorUserId = null, action, entityType = null, entityId = null, metadata = {}, ip = null }) {
  try {
    await query(
      `INSERT INTO audit_log (workspace_id, actor_user_id, action, entity_type, entity_id, metadata, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [workspaceId, actorUserId, action, entityType, entityId, metadata, ip]
    );
  } catch (err) {
    // Never block the request on this, but it must be visible: an audit gap
    // is itself a finding.
    log.error({ action, workspaceId, actorUserId, err: err.message }, 'audit write failed');
  }
}

module.exports = { asyncHandler, audit };
