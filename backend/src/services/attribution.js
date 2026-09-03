'use strict';
// Moving a link or a payment to another creator or agent. Both routes ask the
// same two things: is the new pair legal, and rewrite the ledger for it.

// The account must be in the workspace and not archived; the agent, when there
// is one, must be in the workspace and assigned to that account. Returns the
// resolved pair, or the error the route should report.
async function resolveAttribution(c, workspaceId, { accountId, agentId }) {
  const account = (await c.query(
    "SELECT id FROM accounts WHERE id = $1 AND workspace_id = $2 AND status <> 'archived'",
    [accountId, workspaceId])).rows[0];
  if (!account) return { err: 'account_not_found', fields: ['accountId'] };

  if (agentId) {
    const agent = (await c.query(
      'SELECT id FROM agents WHERE id = $1 AND workspace_id = $2', [agentId, workspaceId])).rows[0];
    if (!agent) return { err: 'agent_not_found', fields: ['agentId'] };
    const assigned = (await c.query(
      'SELECT 1 FROM account_agents WHERE account_id = $1 AND agent_id = $2', [accountId, agentId])).rows[0];
    if (!assigned) return { err: 'agent_not_assigned_to_account', fields: ['agentId'] };
  }
  return { accountId, agentId };
}

// Re-post every approved sale on these payments against the attribution the
// payments now carry. Deleting first is what makes it a rewrite: the new
// entries are unpaid, whatever the old ones had settled. Returns how many.
// A reversed sale is refused before this: its refund entry mirrors the sale
// posted against the old creator, and re-posting only one half of the pair
// would leave the two attributed to different people.
async function repostSales(c, paymentIds) {
  const sales = (await c.query(
    `SELECT id FROM transactions
      WHERE payment_id = ANY($1::uuid[]) AND type = 'payment' AND status = 'approved'`, [paymentIds])).rows;
  for (const t of sales) {
    await c.query("DELETE FROM revenue_entries WHERE transaction_id = $1 AND entry_type = 'sale'", [t.id]);
    await c.query('SELECT fn_post_sale($1)', [t.id]);
  }
  return sales.length;
}

module.exports = { resolveAttribution, repostSales };
