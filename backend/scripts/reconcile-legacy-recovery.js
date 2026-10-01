'use strict';

// Imports only source rows absent from the target. It never updates a live
// payment or link: ambiguous ownership stays blocked for manual review.

const { Pool } = require('pg');

const ACCOUNT_ALIASES = new Map([
  ['dina', { canonicalName: 'Bohema', evidence: 'Customer-confirmed alias: Dina = Bohema' }],
  ['tamar', { canonicalName: 'Emuna', evidence: 'Customer-confirmed alias: Emuna = Tamar' }],
]);
const BLOCKED_ACCOUNT_NAMES = new Set(['bar']);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function sourceUrl(sourceDatabase) {
  if (process.env.LEGACY_SOURCE_DATABASE_URL) return process.env.LEGACY_SOURCE_DATABASE_URL;
  const ownerUrl = process.env.MIGRATIONS_DATABASE_URL;
  if (!ownerUrl) throw new Error('LEGACY_SOURCE_DATABASE_URL or MIGRATIONS_DATABASE_URL is required');
  const url = new URL(ownerUrl);
  url.pathname = `/${sourceDatabase}`;
  return url.toString();
}

function summary(rows, amountField) {
  return {
    count: rows.length,
    amount: rows.reduce((total, row) => total + Number(row[amountField] || 0), 0),
  };
}

function rowList(map) {
  return [...map.values()];
}

function addBlock(blocked, table, row, reason) {
  blocked.push({ table, id: row.id, reason });
}

async function loadWorkspace(pool, workspaceId) {
  const result = await pool.query('SELECT id, name, currency FROM workspaces WHERE id = $1', [workspaceId]);
  if (!result.rows[0]) throw new Error(`Workspace not found: ${workspaceId}`);
  return result.rows[0];
}

async function loadAccounts(pool, workspaceId) {
  return (await pool.query(
    `SELECT a.id, a.name, u.email
       FROM accounts a JOIN users u ON u.id = a.user_id
      WHERE a.workspace_id = $1`,
    [workspaceId],
  )).rows;
}

async function loadAgents(pool, workspaceId) {
  return (await pool.query(
    `SELECT a.id, u.full_name, u.email
       FROM agents a JOIN users u ON u.id = a.user_id
      WHERE a.workspace_id = $1`,
    [workspaceId],
  )).rows;
}

function uniqueBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const value = normalize(row[key]);
    if (!value) continue;
    const values = grouped.get(value) || [];
    values.push(row);
    grouped.set(value, values);
  }
  return grouped;
}

function single(grouped, key) {
  const values = grouped.get(normalize(key)) || [];
  return values.length === 1 ? values[0] : null;
}

function resolveAccounts(sourceAccounts, targetAccounts) {
  const targetByEmail = uniqueBy(targetAccounts, 'email');
  const targetByName = uniqueBy(targetAccounts, 'name');
  const mappings = new Map();
  const blocked = [];

  for (const source of sourceAccounts) {
    const sourceName = normalize(source.name);
    if (BLOCKED_ACCOUNT_NAMES.has(sourceName)) {
      blocked.push({ sourceId: source.id, sourceName: source.name, reason: 'ambiguous_customer_mapping' });
      continue;
    }

    const alias = ACCOUNT_ALIASES.get(sourceName);
    const target = alias
      ? single(targetByName, alias.canonicalName)
      : single(targetByEmail, source.email) || single(targetByName, source.name);
    if (!target) {
      blocked.push({ sourceId: source.id, sourceName: source.name, reason: 'no_unique_target_account' });
      continue;
    }
    mappings.set(source.id, {
      targetId: target.id,
      method: alias ? 'customer_alias' : normalize(source.email) === normalize(target.email) ? 'email' : 'name',
      alias,
    });
  }
  return { mappings, blocked };
}

function resolveAgents(sourceAgents, targetAgents) {
  const targetByEmail = uniqueBy(targetAgents, 'email');
  const mappings = new Map();
  const blocked = [];
  for (const source of sourceAgents) {
    const target = single(targetByEmail, source.email);
    if (!target) {
      blocked.push({ sourceId: source.id, sourceName: source.full_name, reason: 'no_unique_target_agent_email' });
      continue;
    }
    mappings.set(source.id, { targetId: target.id, method: 'email' });
  }
  return { mappings, blocked };
}

async function sourceRows(pool, table, sourceWorkspaceId, targetIds) {
  const result = await pool.query(
    `SELECT * FROM ${table} WHERE workspace_id = $1 AND NOT (id = ANY($2::uuid[])) ORDER BY id`,
    [sourceWorkspaceId, targetIds],
  );
  return result.rows;
}

async function targetIds(pool, table, targetWorkspaceId) {
  return (await pool.query(`SELECT id FROM ${table} WHERE workspace_id = $1`, [targetWorkspaceId]))
    .rows.map((row) => row.id);
}

function resolveForeignId(id, mappings, table, row, blocked, nullable = true) {
  if (!id) return null;
  const mapping = mappings.get(id);
  if (mapping) return mapping.targetId;
  addBlock(blocked, table, row, `unmapped_${table}`);
  return nullable ? null : undefined;
}

function prepareRows(missing, mappings, blocked) {
  const ready = { payment_links: [], payments: [], transactions: [], revenue_entries: [] };
  const knownLinks = new Set(mappings.targetLinkIds);
  const knownPayments = new Set(mappings.targetPaymentIds);
  const knownTransactions = new Set(mappings.targetTransactionIds);

  for (const row of missing.payment_links) {
    const accountId = resolveForeignId(row.account_id, mappings.accounts, 'payment_links', row, blocked, false);
    const agentId = resolveForeignId(row.created_by_agent_id, mappings.agents, 'payment_links', row, blocked);
    if (!accountId || (row.created_by_agent_id && !agentId) || row.customer_id) {
      if (row.customer_id) addBlock(blocked, 'payment_links', row, 'source_customer_requires_review');
      continue;
    }
    ready.payment_links.push({ ...row, workspace_id: mappings.targetWorkspaceId, account_id: accountId, created_by_agent_id: agentId });
    knownLinks.add(row.id);
  }

  for (const row of missing.payments) {
    const accountId = resolveForeignId(row.account_id, mappings.accounts, 'payments', row, blocked, false);
    const agentId = resolveForeignId(row.agent_id, mappings.agents, 'payments', row, blocked);
    if (!accountId || (row.agent_id && !agentId) || row.customer_id || row.category_id
      || (row.payment_link_id && !knownLinks.has(row.payment_link_id))) {
      if (row.customer_id) addBlock(blocked, 'payments', row, 'source_customer_requires_review');
      if (row.category_id) addBlock(blocked, 'payments', row, 'source_category_requires_review');
      if (row.payment_link_id && !knownLinks.has(row.payment_link_id)) addBlock(blocked, 'payments', row, 'missing_payment_link');
      continue;
    }
    ready.payments.push({ ...row, workspace_id: mappings.targetWorkspaceId, account_id: accountId, agent_id: agentId });
    knownPayments.add(row.id);
  }

  for (const row of missing.transactions) {
    if (!knownPayments.has(row.payment_id)) {
      addBlock(blocked, 'transactions', row, 'missing_payment');
      continue;
    }
    ready.transactions.push({ ...row, workspace_id: mappings.targetWorkspaceId });
    knownTransactions.add(row.id);
  }

  for (const row of missing.revenue_entries) {
    const accountId = resolveForeignId(row.account_id, mappings.accounts, 'revenue_entries', row, blocked);
    const agentId = resolveForeignId(row.agent_id, mappings.agents, 'revenue_entries', row, blocked);
    if ((row.account_id && !accountId) || (row.agent_id && !agentId)
      || row.account_payout_id || row.agent_payout_id || !knownTransactions.has(row.transaction_id)) {
      if (row.account_payout_id || row.agent_payout_id) addBlock(blocked, 'revenue_entries', row, 'source_payout_requires_review');
      if (!knownTransactions.has(row.transaction_id)) addBlock(blocked, 'revenue_entries', row, 'missing_transaction');
      continue;
    }
    ready.revenue_entries.push({
      ...row,
      workspace_id: mappings.targetWorkspaceId,
      account_id: accountId,
      agent_id: agentId,
    });
  }
  return ready;
}

async function insertRow(client, table, columns, row) {
  const values = columns.map((column) => row[column] ?? null);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  const result = await client.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING RETURNING id`,
    values,
  );
  if (result.rowCount !== 1) throw new Error(`Concurrent or duplicate ${table} row: ${row.id}`);
}

async function apply(client, context) {
  const { migrationKey, sourceDatabase, sourceWorkspaceId, targetWorkspaceId, accounts, agents, ready, report } = context;
  await client.query(
    `INSERT INTO legacy_import_runs
       (migration_key, source_database, source_workspace_id, target_workspace_id, status, source_summary, target_summary, committed_at)
     VALUES ($1,$2,$3,$4,'committed',$5,$6,now())`,
    [migrationKey, sourceDatabase, sourceWorkspaceId, targetWorkspaceId, report.source, report.target],
  );

  for (const [sourceId, mapping] of accounts) {
    await client.query(
      `INSERT INTO legacy_entity_mappings
         (source_database, source_workspace_id, source_table, source_id, target_id, migration_key, mapping_method)
       VALUES ($1,$2,'accounts',$3,$4,$5,$6)
       ON CONFLICT (source_database, source_workspace_id, source_table, source_id) DO NOTHING`,
      [sourceDatabase, sourceWorkspaceId, sourceId, mapping.targetId, migrationKey, mapping.method],
    );
  }
  for (const [sourceId, mapping] of agents) {
    await client.query(
      `INSERT INTO legacy_entity_mappings
         (source_database, source_workspace_id, source_table, source_id, target_id, migration_key, mapping_method)
       VALUES ($1,$2,'agents',$3,$4,$5,$6)
       ON CONFLICT (source_database, source_workspace_id, source_table, source_id) DO NOTHING`,
      [sourceDatabase, sourceWorkspaceId, sourceId, mapping.targetId, migrationKey, mapping.method],
    );
  }

  for (const [sourceId, mapping] of accounts) {
    if (!mapping.alias) continue;
    const source = context.sourceAccounts.find((account) => account.id === sourceId);
    await client.query(
      `INSERT INTO creator_aliases
         (workspace_id, source_database, source_account_id, source_name, canonical_account_id, evidence)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (source_database, source_account_id) DO NOTHING`,
      [targetWorkspaceId, sourceDatabase, sourceId, source.name, mapping.targetId, mapping.alias.evidence],
    );
  }

  const columns = {
    payment_links: ['id', 'workspace_id', 'account_id', 'customer_id', 'created_by_agent_id', 'description', 'type',
      'pricing_mode', 'amount', 'checkout_fee', 'currency', 'status', 'reference_id', 'provider_request_id',
      'provider_link_id', 'checkout_url', 'expires_at', 'paid_at', 'archived_at', 'created_at', 'updated_at'],
    payments: ['id', 'workspace_id', 'account_id', 'payment_link_id', 'customer_id', 'category_id', 'agent_id',
      'amount', 'currency', 'status', 'payment_method', 'provider_payment_id', 'review_reason', 'archived_at',
      'occurred_at', 'created_at', 'updated_at'],
    transactions: ['id', 'workspace_id', 'payment_id', 'type', 'status', 'gross', 'fee', 'fee_is_estimate',
      'surcharge', 'net', 'currency', 'provider_transaction_id', 'occurred_at', 'raw_payload', 'created_at'],
    revenue_entries: ['id', 'workspace_id', 'transaction_id', 'account_id', 'agent_id', 'entry_type', 'status',
      'gross', 'platform_fee', 'platform_margin', 'psp_fee', 'distributable', 'account_amount', 'agent_amount',
      'agency_amount', 'account_payout_id', 'agent_payout_id', 'account_paid_at', 'agent_paid_at', 'created_at'],
  };
  for (const table of Object.keys(columns)) {
    for (const row of ready[table]) await insertRow(client, table, columns[table], row);
  }
}

async function main() {
  const sourceDatabase = requiredArgument('--source-database');
  const sourceWorkspaceId = requiredArgument('--source-workspace-id');
  const targetWorkspaceId = requiredArgument('--target-workspace-id');
  const migrationKey = requiredArgument('--migration-key');
  const applyRequested = process.argv.includes('--apply');
  if (applyRequested && process.env.LEGACY_IMPORT_CONFIRM !== migrationKey) {
    throw new Error('Set LEGACY_IMPORT_CONFIRM to the migration key before using --apply');
  }

  const source = new Pool({ connectionString: sourceUrl(sourceDatabase) });
  const target = new Pool({ connectionString: process.env.MIGRATIONS_DATABASE_URL });
  try {
    await loadWorkspace(source, sourceWorkspaceId);
    await loadWorkspace(target, targetWorkspaceId);
    const [sourceAccounts, targetAccounts, sourceAgents, targetAgents] = await Promise.all([
      loadAccounts(source, sourceWorkspaceId), loadAccounts(target, targetWorkspaceId),
      loadAgents(source, sourceWorkspaceId), loadAgents(target, targetWorkspaceId),
    ]);
    const accountResolution = resolveAccounts(sourceAccounts, targetAccounts);
    const agentResolution = resolveAgents(sourceAgents, targetAgents);
    const tables = ['payment_links', 'payments', 'transactions', 'revenue_entries'];
    const targetIdLists = await Promise.all(tables.map((table) => targetIds(target, table, targetWorkspaceId)));
    const missing = Object.fromEntries(await Promise.all(tables.map(async (table, index) => [
      table, await sourceRows(source, table, sourceWorkspaceId, targetIdLists[index]),
    ])));
    const blocked = [];
    const ready = prepareRows(missing, {
      accounts: accountResolution.mappings,
      agents: agentResolution.mappings,
      targetWorkspaceId,
      targetLinkIds: targetIdLists[0],
      targetPaymentIds: targetIdLists[1],
      targetTransactionIds: targetIdLists[2],
    }, blocked);
    const report = {
      migrationKey,
      applyRequested,
      source: Object.fromEntries(tables.map((table) => [table, summary(missing[table], table === 'transactions' || table === 'revenue_entries' ? 'gross' : 'amount')])),
      target: Object.fromEntries(tables.map((table) => [table, summary(ready[table], table === 'transactions' || table === 'revenue_entries' ? 'gross' : 'amount')])),
      accountAliases: rowList(accountResolution.mappings).filter((mapping) => mapping.alias).length,
      blockedAccounts: accountResolution.blocked,
      blockedAgents: agentResolution.blocked,
      blockedRows: blocked,
    };

    if (applyRequested) {
      const client = await target.connect();
      try {
        await client.query('BEGIN');
        const previous = await client.query('SELECT 1 FROM legacy_import_runs WHERE migration_key = $1', [migrationKey]);
        if (previous.rowCount) throw new Error(`Migration key already used: ${migrationKey}`);
        await apply(client, {
          migrationKey, sourceDatabase, sourceWorkspaceId, targetWorkspaceId,
          accounts: accountResolution.mappings, agents: agentResolution.mappings,
          ready, report, sourceAccounts,
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.blockedAccounts.length || report.blockedAgents.length || report.blockedRows.length) process.exitCode = 2;
  } finally {
    await source.end();
    await target.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`legacy recovery reconciliation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { resolveAccounts, resolveAgents, prepareRows };
