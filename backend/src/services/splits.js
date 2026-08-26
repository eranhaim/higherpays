'use strict';
// An account's share and an agent's commission both come out of the same
// distributable amount, so together they must not exceed 100%. fn_post_sale
// refuses to post a sale that breaks this; these let the settings routes
// refuse the change up front with a clear message.

/** Highest commission any agent in the workspace holds. */
async function maxAgentPct(client, workspaceId) {
  const { rows } = await client.query(
    'SELECT COALESCE(max(commission_pct), 0) AS pct FROM agents WHERE workspace_id = $1', [workspaceId]);
  return Number(rows[0].pct);
}

/** Highest share among accounts that can still make sales. */
async function maxAccountSplitPct(client, workspaceId) {
  const { rows } = await client.query(
    `SELECT COALESCE(max(revenue_split_pct), 0) AS pct FROM accounts
      WHERE workspace_id = $1 AND status <> 'archived'`, [workspaceId]);
  return Number(rows[0].pct);
}

module.exports = { maxAgentPct, maxAccountSplitPct };
