'use strict';
// An account's rev-share and an agent's commission both come out of the same
// distributable amount, so together they must not exceed 100%. fn_post_sale
// refuses to post a sale that breaks this; these helpers let the settings
// routes refuse the change up front with a clear message.

/** Highest agent commission that could apply to a sale in this workspace. */
async function maxAgentPct(client, workspaceId) {
  const { rows } = await client.query(
    `SELECT GREATEST(
       COALESCE((SELECT agent_pct FROM commission_rules
                  WHERE workspace_id = $1 AND account_id IS NULL AND effective_from <= now()
                  ORDER BY effective_from DESC LIMIT 1), 0),
       COALESCE((SELECT max(commission_pct) FROM memberships
                  WHERE workspace_id = $1 AND role = 'agent' AND status = 'active'), 0)
     ) AS pct`, [workspaceId]);
  return Number(rows[0].pct);
}

/** Highest rev-share split among accounts that can still make sales. */
async function maxAccountSplitPct(client, workspaceId) {
  const { rows } = await client.query(
    `SELECT COALESCE(max(revenue_split_pct), 0) AS pct FROM accounts
      WHERE workspace_id = $1 AND revenue_model = 'revshare' AND status <> 'archived'`, [workspaceId]);
  return Number(rows[0].pct);
}

module.exports = { maxAgentPct, maxAccountSplitPct };
