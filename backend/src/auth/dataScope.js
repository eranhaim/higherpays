'use strict';
const { hasPermission } = require('./permissions');

// Which ROWS a caller may see, as opposed to which endpoints they may call.
// requirePermission answers the second question; this answers the first.
//
//   workspace — every row in the workspace
//   agent     — only their own work: links they created, payments credited to
//               them, the accounts they are assigned
//   account   — only the account they own
//
// The agent and account records are looked up by (workspace, user). A role
// with neither record and without data.view_all sees nothing, rather than
// falling through to the whole workspace.

const WORKSPACE_SCOPE = { kind: 'workspace', agentId: null, accountId: null };

async function resolveDataScope(client, req) {
  const access = req.access;
  if (hasPermission(access, 'data.view_all')) return WORKSPACE_SCOPE;

  if (access.role === 'agent') {
    const agent = (await client.query(
      'SELECT id FROM agents WHERE workspace_id = $1 AND user_id = $2', [access.workspaceId, req.user.id])).rows[0];
    if (agent) return { kind: 'agent', agentId: agent.id, accountId: null };
  }
  if (access.role === 'account_owner') {
    const account = (await client.query(
      'SELECT id FROM accounts WHERE workspace_id = $1 AND user_id = $2', [access.workspaceId, req.user.id])).rows[0];
    if (account) return { kind: 'account', agentId: null, accountId: account.id };
  }
  return { kind: 'none', agentId: null, accountId: null };
}

// Predicate fragments every scoped list shares. $agent and $account are the
// parameter placeholders the caller binds; NULL for the kinds that do not apply.
const ASSIGNED_ACCOUNTS = 'SELECT account_id FROM account_agents WHERE agent_id = $1';

// [agentId, accountId] in the order the shared predicates expect.
function scopeParams(scope) {
  return [scope.kind === 'agent' ? scope.agentId : null, scope.kind === 'account' ? scope.accountId : null];
}

module.exports = { resolveDataScope, ASSIGNED_ACCOUNTS, scopeParams };
