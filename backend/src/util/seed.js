'use strict';
// One-command bootstrap for a fresh install: two independent agencies, each
// with its own workspace, one login per role, its own accounts and agents, and
// its own fee and split settings. Plus one platform admin who is above both.
//
//   SEED_PASSWORD='strong-pass' npm run seed
//
// No payment links, payments or transactions are invented — those only ever
// come from MantaPay. What is seeded is the structure you need in order to sign
// in as every role and see the permission boundaries work.
//
// Idempotent: one transaction, every statement an upsert, so a rerun changes
// nothing and adds no rows.
const { Pool } = require('pg');
const config = require('../config');
const { hashPassword } = require('../auth/passwords');

const PASSWORD = process.env.SEED_PASSWORD || 'higherpays123';
const PLATFORM_ADMIN_EMAIL = process.env.SEED_PLATFORM_ADMIN || 'platform@higherpays.test';

// One person who works for both agencies, to exercise the path where a single
// login sees more than one workspace without being a platform admin.
const SHARED_ANALYST = { email: 'finance@higherpays.test', fullName: 'Sam Okafor', role: 'analyst' };

// The two agencies deliberately differ in vocabulary, split and fee model, so
// anything that hardcodes one of them shows up immediately.
const AGENCIES = [
  {
    slug: 'acme',
    name: 'Acme Agency',
    currency: 'EUR',
    merchantId: 'MID-ACME-001',
    labels: { account: 'Creator', accounts: 'Creators', agent: 'Chatter', agents: 'Chatters' },
    linkLimits: { min: 5, max: 2000 },
    fees: {
      feeModel: 'cascade',
      pspRatePct: 8, mdrPct: 7, settlementPct: 1, pspFixedFee: 0.5, marginRatePct: 5,
    },
    settlementFees: {
      chargebackFee: 15, refundFee: 1, declineFee: 0.25,
      settlementFeePct: 0, settlementFeeFlat: 0, reservePct: 5, reserveReleaseDays: 90,
    },
    split: { account: 70, agency: 22, agent: 8 },
    categories: ['Subscription', 'Custom content', 'Tip', 'Bundle'],
    accounts: [
      { handle: 'luna', name: 'Luna Vega', country: 'ES', splitPct: 70 },
      { handle: 'mila', name: 'Mila Novak', country: 'CZ', splitPct: 75 },
    ],
    agents: [
      { key: 'dayagent', fullName: 'Dana Roth', country: 'IL', commissionPct: 8, works: ['luna', 'mila'] },
      { key: 'nightagent', fullName: 'Nikolai Petrov', country: 'RS', commissionPct: 10, works: ['mila'] },
      // Left the agency. Access is suspended but the agent record stays, so
      // past payments keep their attribution.
      { key: 'formeragent', fullName: 'Tomas Weber', country: 'DE', commissionPct: 8, works: [], status: 'suspended' },
    ],
  },
  {
    slug: 'northstar',
    name: 'Northstar Media',
    currency: 'USD',
    merchantId: 'MID-NORTH-002',
    labels: { account: 'Talent', accounts: 'Talent', agent: 'Closer', agents: 'Closers' },
    linkLimits: { min: 10, max: 5000 },
    fees: {
      feeModel: 'flat',
      pspRatePct: 6.5, mdrPct: null, settlementPct: null, pspFixedFee: 0.3, marginRatePct: 3,
    },
    settlementFees: {
      chargebackFee: 20, refundFee: 2, declineFee: 0.4,
      settlementFeePct: 0.5, settlementFeeFlat: 25, reservePct: 0, reserveReleaseDays: 0,
    },
    split: { account: 60, agency: 30, agent: 10 },
    categories: ['Coaching', 'Merch', 'Event'],
    accounts: [
      { handle: 'rae', name: 'Rae Sinclair', country: 'US', splitPct: 60 },
    ],
    agents: [
      { key: 'closer', fullName: 'Marco Ruiz', country: 'US', commissionPct: 10, works: ['rae'] },
    ],
  },
];

// --- upserts ---------------------------------------------------------------
// Each returns the row's id whether it inserted or found it, so the seed never
// has to ask how far the last run got.

// The password hash is rewritten every run on purpose: it keeps the login table
// this script prints true even if someone changed a seeded password.
async function upsertUser(c, { email, fullName, passwordHash, isPlatformAdmin = false }) {
  return (await c.query(
    `INSERT INTO users (email, full_name, password_hash, is_platform_admin)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE
       SET full_name = EXCLUDED.full_name,
           password_hash = EXCLUDED.password_hash,
           is_platform_admin = EXCLUDED.is_platform_admin
     RETURNING id`,
    [email, fullName, passwordHash, isPlatformAdmin])).rows[0].id;
}

// workspaces has no natural unique key, so look before inserting. Safe here:
// one process, inside one transaction.
async function upsertWorkspace(c, agency) {
  const found = (await c.query(
    'SELECT id, webhook_endpoint_id FROM workspaces WHERE name = $1', [agency.name])).rows[0];
  if (found) return found;
  return (await c.query(
    `INSERT INTO workspaces (name, currency, merchant_id,
                             min_link_amount, max_link_amount,
                             account_label, account_label_plural,
                             agent_label, agent_label_plural)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, webhook_endpoint_id`,
    [agency.name, agency.currency, agency.merchantId,
     agency.linkLimits.min, agency.linkLimits.max,
     agency.labels.account, agency.labels.accounts,
     agency.labels.agent, agency.labels.agents])).rows[0];
}

async function upsertAccess(c, workspaceId, userId, role, status = 'active') {
  await c.query(
    `INSERT INTO workspace_users (workspace_id, user_id, role, status)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id, user_id) DO UPDATE
       SET role = EXCLUDED.role, status = EXCLUDED.status`,
    [workspaceId, userId, role, status]);
}

async function upsertAccount(c, workspaceId, userId, account) {
  return (await c.query(
    `INSERT INTO accounts (workspace_id, user_id, name, handle, country, status, revenue_split_pct)
     VALUES ($1,$2,$3,$4,$5,'active',$6)
     ON CONFLICT (workspace_id, user_id) DO UPDATE
       SET name = EXCLUDED.name, revenue_split_pct = EXCLUDED.revenue_split_pct
     RETURNING id`,
    [workspaceId, userId, account.name, account.handle, account.country, account.splitPct])).rows[0].id;
}

async function upsertAgent(c, workspaceId, userId, agent) {
  return (await c.query(
    `INSERT INTO agents (workspace_id, user_id, country, commission_pct)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id, user_id) DO UPDATE
       SET commission_pct = EXCLUDED.commission_pct
     RETURNING id`,
    [workspaceId, userId, agent.country, agent.commissionPct])).rows[0].id;
}

async function assignAgent(c, workspaceId, accountId, agentId) {
  await c.query(
    `INSERT INTO account_agents (workspace_id, account_id, agent_id)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [workspaceId, accountId, agentId]);
}

async function upsertCategories(c, workspaceId, names) {
  for (const name of names) {
    await c.query(
      `INSERT INTO categories (workspace_id, name) VALUES ($1,$2)
       ON CONFLICT (workspace_id, name) DO NOTHING`, [workspaceId, name]);
  }
}

// The three effective-dated settings tables have no unique key by design — a
// new row is a new rate from now on. The seed writes one only if none exists.
async function seedOnce(c, table, columns, values, workspaceId) {
  const { rowCount } = await c.query(`SELECT 1 FROM ${table} WHERE workspace_id = $1 LIMIT 1`, [workspaceId]);
  if (rowCount) return;
  const params = columns.map((_, i) => `$${i + 1}`).join(',');
  await c.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${params})`, values);
}

// --- seed ------------------------------------------------------------------

async function seedAgency(c, agency, passwordHash, platformAdminId) {
  const workspace = await upsertWorkspace(c, agency);
  const logins = [];

  const person = async (key, fullName, role, status = 'active') => {
    const email = `${key}@${agency.slug}.test`;
    const userId = await upsertUser(c, { email, fullName, passwordHash });
    await upsertAccess(c, workspace.id, userId, role, status);
    logins.push({ email, role, status });
    return userId;
  };

  // A platform admin needs access in every workspace to see anything in it.
  await upsertAccess(c, workspace.id, platformAdminId, 'workspace_admin');

  const adminId = await person('admin', `${agency.name} Admin`, 'workspace_admin');
  await person('analyst', `${agency.name} Analyst`, 'analyst');

  const accountIds = {};
  for (const account of agency.accounts) {
    const userId = await person(account.handle, account.name, 'account_owner');
    accountIds[account.handle] = await upsertAccount(c, workspace.id, userId, account);
  }

  for (const agent of agency.agents) {
    const userId = await person(agent.key, agent.fullName, 'agent', agent.status);
    const agentId = await upsertAgent(c, workspace.id, userId, agent);
    for (const handle of agent.works) {
      await assignAgent(c, workspace.id, accountIds[handle], agentId);
    }
  }

  await upsertCategories(c, workspace.id, agency.categories);

  const f = agency.fees;
  await seedOnce(c, 'platform_fee_rates',
    ['workspace_id', 'fee_model', 'psp_rate_pct', 'mdr_pct', 'settlement_pct',
     'psp_fixed_fee', 'margin_rate_pct', 'created_by_user_id'],
    [workspace.id, f.feeModel, f.pspRatePct, f.mdrPct, f.settlementPct,
     f.pspFixedFee, f.marginRatePct, platformAdminId],
    workspace.id);

  const s = agency.settlementFees;
  await seedOnce(c, 'settlement_fee_config',
    ['workspace_id', 'chargeback_fee', 'refund_fee', 'decline_fee', 'settlement_fee_pct',
     'settlement_fee_flat', 'reserve_pct', 'reserve_release_days', 'created_by_user_id'],
    [workspace.id, s.chargebackFee, s.refundFee, s.declineFee, s.settlementFeePct,
     s.settlementFeeFlat, s.reservePct, s.reserveReleaseDays, platformAdminId],
    workspace.id);

  // accountId null is the workspace-wide default rule.
  await seedOnce(c, 'revenue_rules',
    ['workspace_id', 'account_split_pct', 'agency_split_pct', 'agent_pct', 'created_by_user_id'],
    [workspace.id, agency.split.account, agency.split.agency, agency.split.agent, adminId],
    workspace.id);

  return { workspace, logins };
}

async function main() {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const passwordHash = await hashPassword(PASSWORD);

    const platformAdminId = await upsertUser(c, {
      email: PLATFORM_ADMIN_EMAIL,
      fullName: 'HigherPays Platform Admin',
      passwordHash,
      isPlatformAdmin: true,
    });

    const seeded = [];
    for (const agency of AGENCIES) {
      seeded.push({ agency, ...(await seedAgency(c, agency, passwordHash, platformAdminId)) });
    }

    const sharedAnalystId = await upsertUser(c, {
      email: SHARED_ANALYST.email, fullName: SHARED_ANALYST.fullName, passwordHash,
    });
    for (const { workspace } of seeded) {
      await upsertAccess(c, workspace.id, sharedAnalystId, SHARED_ANALYST.role);
    }
    await c.query('COMMIT');

    console.log(`\nPassword for every login below: ${PASSWORD}\n`);
    console.log(`  ${PLATFORM_ADMIN_EMAIL.padEnd(32)} platform admin, every workspace`);
    console.log(`  ${SHARED_ANALYST.email.padEnd(32)} ${SHARED_ANALYST.role}, every workspace`);
    for (const { agency, workspace, logins } of seeded) {
      console.log(`\n${agency.name}  (${agency.currency}, webhook ${workspace.webhook_endpoint_id})`);
      for (const { email, role, status } of logins) {
        const suffix = status === 'active' ? '' : `  [${status}]`;
        console.log(`  ${email.padEnd(32)} ${role}${suffix}`);
      }
    }
    console.log('');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
