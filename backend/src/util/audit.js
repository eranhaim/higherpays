'use strict';
const { query } = require('../db');
const { log } = require('../lib/log');
const { AsyncLocalStorage } = require('async_hooks');

const requestContext = new AsyncLocalStorage();

function auditRequestContext(req, _res, next) {
  requestContext.run({ req }, next);
}

// Append an entry to the audit log. Best-effort: never block the request path
// on an audit write failure, but do log it.
async function audit({ workspaceId = null, actorUserId = null, action, entityType = null, entityId = null, metadata = {}, ip = null }) {
  const req = requestContext.getStore()?.req;
  const effectiveUserId = req?.user?.id || actorUserId;
  const resolvedActorUserId = req?.user?.actorId || actorUserId;
  try {
    await query(
      `INSERT INTO audit_log
         (workspace_id, actor_user_id, effective_user_id, action, entity_type, entity_id, metadata, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [workspaceId, resolvedActorUserId, effectiveUserId, action, entityType, entityId, metadata, ip]
    );
  } catch (err) {
    // Never block the request on this, but it must be visible: an audit gap
    // is itself a finding.
    log.error({ action, workspaceId, actorUserId: resolvedActorUserId, err: err.message }, 'audit write failed');
  }
}

module.exports = { audit, auditRequestContext };
