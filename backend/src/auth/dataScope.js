'use strict';
const { hasPermission } = require('./permissions');

// Which ROWS a caller may see, as opposed to which endpoints they may call.
// requirePermission answers the second question; this answers the first. They
// are orthogonal — an agent legitimately reaches the accounts endpoint, and
// legitimately gets only the accounts they are assigned.
//
// Scope is derived from a permission, never from the role name. Role names are
// editable per workspace and a custom role would silently fall outside a
// `role === 'agent'` check and get everything.
//
//   workspace — every row in the workspace
//   agent     — only their own work (links they created, sales credited to them,
//               accounts they are assigned, those accounts' customers)
//   account   — only the account record linked to their user
//
// Order matters and is fail-closed: a role nobody has configured lands on
// `agent`, the narrowest scope, rather than seeing the workspace.

const WORKSPACE_SCOPE = { kind: 'workspace', membershipId: null, accountId: null };

async function resolveDataScope(client, req) {
  const membership = req.membership;
  if (membership.isPlatformOperator) return WORKSPACE_SCOPE;
  if (hasPermission(membership, 'data.view_all')) return WORKSPACE_SCOPE;

  // A user linked to an account record is that account, even if they also hold
  // a membership — matches how /me/earnings decides which party is asking.
  const linked = (await client.query(
    'SELECT id FROM accounts WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [membership.workspaceId, req.user.id])).rows[0];
  if (linked) return { kind: 'account', membershipId: membership.id, accountId: linked.id };

  return { kind: 'agent', membershipId: membership.id, accountId: null };
}

/** Accounts an agent is assigned to. Used as a subquery, so it stays one round trip. */
const ASSIGNED_ACCOUNTS = 'SELECT account_id FROM account_agents WHERE membership_id = $1';

module.exports = { resolveDataScope, ASSIGNED_ACCOUNTS };
