'use strict';
// One-command bootstrap for a fresh install: two independent agencies, each with
// its own workspace and one login per role, plus a platform super-admin who can
// see across both. Enough to exercise every permission path and the tenant
// boundary by signing in — no accounts, links or payments are invented.
//
//   SEED_PASSWORD='strong-pass' npm run seed
//
// Idempotent: the whole seed is one transaction and every statement is an
// upsert, so a rerun changes nothing and adds no rows.
const { Pool } = require('pg');
const config = require('../config');
const { hashPassword } = require('../auth/passwords');
const { seedRolesForWorkspace } = require('../auth/permissions');

const PASSWORD = process.env.SEED_PASSWORD || 'higherpays123';
const SUPER_ADMIN_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL || 'super@higherpays.test';
const PSP = Number(process.env.SEED_PSP_RATE || 8);
const MARGIN = Number(process.env.SEED_MARGIN_RATE || 0);
const ACCOUNT_SPLIT = Number(process.env.SEED_ACCOUNT_SPLIT || 70);
const AGENT_PCT = Number(process.env.SEED_AGENT_PCT || 8);
const CHARGEBACK_FEE = Number(process.env.SEED_CHARGEBACK_FEE || 15);

// One user per role. `owner` is the Workspace Owner; `account` and `agent`
// follow the entity model (an account holder and the agent selling for them).
const ROLES = ['owner', 'admin', 'analyst', 'agent', 'account'];

const ORGS = [
  { name: process.env.SEED_ORG_1 || 'Acme Agency', slug: 'acme' },
  { name: process.env.SEED_ORG_2 || 'Northstar Media', slug: 'northstar' },
];

const titleCase = (s) => s[0].toUpperCase() + s.slice(1);

// Upsert helpers. Each returns the row's id whether it was inserted or already
// there, so the seed never has to ask "did the last run get this far?".
async function upsertOrganization(c, { name, slug }) {
  return (await c.query(
    `INSERT INTO organizations (name, slug) VALUES ($1,$2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`, [name, slug])).rows[0].id;
}

// workspaces has no natural unique key, so look before inserting. Safe here:
// one process, inside a transaction.
async function upsertWorkspace(c, organizationId, name) {
  const found = (await c.query(
    'SELECT id, webhook_endpoint_id FROM workspaces WHERE organization_id = $1 LIMIT 1', [organizationId])).rows[0];
  if (found) return found;
  return (await c.query(
    `INSERT INTO workspaces (organization_id, name, currency, mid, provider_name)
     VALUES ($1,$2,'EUR',$3,'mantapay') RETURNING id, webhook_endpoint_id`,
    [organizationId, name, process.env.SEED_MID || 'MID-SET-ME'])).rows[0];
}

// The password hash is rewritten on every run on purpose: it keeps the login
// table this script prints true even if someone changed a seeded password.
async function upsertUser(c, email, fullName, passwordHash) {
  return (await c.query(
    `INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, password_hash = EXCLUDED.password_hash
     RETURNING id`, [email, passwordHash, fullName])).rows[0].id;
}

// Effective-dated config tables have no unique key; without this guard a rerun
// would append a second version of the same rate card.
async function insertOnce(c, table, sql, values) {
  const exists = (await c.query(`SELECT 1 FROM ${table} WHERE organization_id = $1 LIMIT 1`, [values[0]])).rows[0];
  if (!exists) await c.query(sql, values);
}

async function seedOrganization(c, org, passwordHash) {
  const organizationId = await upsertOrganization(c, org);
  const ws = await upsertWorkspace(c, organizationId, org.name);
  await seedRolesForWorkspace(c, ws.id);

  const logins = [];
  const byRole = {};
  for (const role of ROLES) {
    const email = `${role}@${org.slug}.test`;
    const userId = await upsertUser(c, email, `${org.name} ${titleCase(role)}`, passwordHash);
    byRole[role] = userId;
    await c.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'`,
      [ws.id, userId, role]);
    logins.push({ org: org.name, role, email });
  }

  await insertOnce(c, 'platform_fee_rates',
    'INSERT INTO platform_fee_rates (organization_id, psp_rate_pct, margin_rate_pct) VALUES ($1,$2,$3)',
    [organizationId, PSP, MARGIN]);
  await insertOnce(c, 'settlement_fee_config',
    'INSERT INTO settlement_fee_config (organization_id, chargeback_fee) VALUES ($1,$2)',
    [organizationId, CHARGEBACK_FEE]);

  // The org chart, not demo money. Scope is derived from these two rows: the
  // account user is only an "account" because an accounts row points at them,
  // and the agent only sees that account because it is assigned. Without them
  // both roles resolve to an empty view and neither can be exercised.
  const account = (await c.query(
    `INSERT INTO accounts (workspace_id, stage_name, revenue_model, revenue_split_pct, status, user_id)
     VALUES ($1,$2,'revshare',$3,'active',$4)
     ON CONFLICT (workspace_id, user_id) WHERE user_id IS NOT NULL
       DO UPDATE SET stage_name = EXCLUDED.stage_name
     RETURNING id`,
    [ws.id, `${org.name} Talent`, ACCOUNT_SPLIT, byRole.account])).rows[0];
  await c.query(
    `INSERT INTO account_compliance (workspace_id, account_id) VALUES ($1,$2)
     ON CONFLICT (account_id) DO NOTHING`, [ws.id, account.id]);
  await c.query(
    `INSERT INTO account_agents (workspace_id, account_id, membership_id)
     SELECT $1, $2, m.id FROM memberships m WHERE m.workspace_id = $1 AND m.user_id = $3
     ON CONFLICT (account_id, membership_id) DO NOTHING`,
    [ws.id, account.id, byRole.agent]);

  const hasRule = (await c.query('SELECT 1 FROM commission_rules WHERE workspace_id = $1 LIMIT 1', [ws.id])).rows[0];
  if (!hasRule) {
    await c.query(
      `INSERT INTO commission_rules (workspace_id, account_id, account_split_pct, agency_split_pct, agent_pct)
       VALUES ($1,NULL,$2,$3,$4)`,
      [ws.id, ACCOUNT_SPLIT, 100 - ACCOUNT_SPLIT, AGENT_PCT]);
  }

  return { workspace: ws, logins };
}

function printLogins(rows) {
  const head = { org: 'Org', role: 'Role', email: 'Email' };
  const width = (key) => Math.max(...[head, ...rows].map((r) => r[key].length));
  const w = { org: width('org'), role: width('role'), email: width('email') };
  const line = (r) => `  ${r.org.padEnd(w.org)}  ${r.role.padEnd(w.role)}  ${r.email.padEnd(w.email)}`;
  console.log(line(head));
  rows.forEach((r) => console.log(line(r)));
}

async function run() {
  if (String(PASSWORD).length < 8) { console.error('SEED_PASSWORD must be at least 8 characters.'); process.exit(1); }
  const pool = new Pool({ connectionString: config.databaseUrl });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Every tenant table is under RLS in the database itself, whether or not the
    // app is configured to set request context, so the seed always claims
    // platform context. The GUC is inert when no policy reads it.
    await c.query("SELECT set_config('app.platform_admin','on',true)");

    const passwordHash = await hashPassword(PASSWORD);
    const seeded = [];
    for (const org of ORGS) seeded.push(await seedOrganization(c, org, passwordHash));

    // The super-admin holds no membership: requireWorkspace grants a synthetic
    // one on any workspace, so a seat would add nothing.
    const superAdminId = await upsertUser(c, SUPER_ADMIN_EMAIL, 'HigherPays Super Admin', passwordHash);
    await c.query(
      "INSERT INTO platform_admins (user_id, role) VALUES ($1,'super_admin') ON CONFLICT (user_id) DO NOTHING",
      [superAdminId]);

    await c.query('COMMIT');

    console.log('\n✅ Seed complete.\n');
    printLogins([
      ...seeded.flatMap((s) => s.logins),
      { org: '(platform)', role: 'super_admin', email: SUPER_ADMIN_EMAIL },
    ]);
    console.log(`\n  Password for every account above: ${PASSWORD}`);
    console.log(`  Blended fee: ${PSP + MARGIN}%  (PSP ${PSP}% + margin ${MARGIN}%)`);
    seeded.forEach((s, i) => console.log(
      `  Webhook URL (${ORGS[i].name}): {WEBHOOK_PUBLIC_BASE}/webhooks/payment/${s.workspace.webhook_endpoint_id}`));
    console.log('\n  Each workspace has one account record linked to its `account` user, with');
    console.log('  the `agent` user assigned to it — that is what the two scoped roles resolve');
    console.log('  against. No links, payments or balances are invented.');
    console.log('  Set each workspace MID and the MantaPay hash key before taking real payments.\n');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('Seed failed:', e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

if (require.main === module) run();
module.exports = { run };
