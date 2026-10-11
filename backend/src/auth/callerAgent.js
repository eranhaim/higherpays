'use strict';

// Who the caller IS in this workspace, as opposed to what they may SEE.
//
// resolveDataScope answers the second question, and for a seat holding
// data.view_all it short-circuits to the whole workspace without ever looking
// the agent up. Attribution must therefore never be read out of a data scope:
// an agent who also holds elevated permissions is still that agent, and a link
// they create is still theirs.
//
// Returns null for a caller with no agent profile — an admin or an owner.
async function resolveCallerAgentId(client, req) {
  const agent = (await client.query(
    'SELECT id FROM agents WHERE workspace_id = $1 AND user_id = $2',
    [req.access.workspaceId, req.user.id])).rows[0];
  return agent ? agent.id : null;
}

module.exports = { resolveCallerAgentId };
