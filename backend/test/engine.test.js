'use strict';
// Fee engine tests — these need a real PostgreSQL, because the money math lives
// in SQL functions using exact NUMERIC. Floating point would drift.
//
//   createdb higherpays_test
//   DATABASE_URL=postgres://user:pw@localhost:5432/higherpays_test npm run migrate
//   TEST_DATABASE_URL=postgres://user:pw@localhost:5432/higherpays_test npm run test:db
//
// Skips itself (rather than failing) when TEST_DATABASE_URL is not set, so the
// unit suite still runs on a machine without a database.
const test = require('node:test');
const assert = require('node:assert/strict');

const DSN = process.env.TEST_DATABASE_URL;
if (!DSN) {
  test('fee engine tests (skipped — set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}

const { Pool } = require('pg');
const pool = new Pool({ connectionString: DSN });
const n = (v) => Number(v);

/** Fresh org + workspace + creator + customer, with a known rate card. */
async function fixture(opts = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  const org = (await pool.query(
    "INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id", ['T' + tag, 'o-' + tag])).rows[0].id;
  await pool.query(
    `INSERT INTO platform_fee_rates(organization_id, psp_rate_pct, margin_rate_pct, psp_fixed_fee,
       fee_model, mdr_pct, settlement_pct, effective_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'-infinity')`,
    [org, opts.pspRate ?? 8, opts.margin ?? 5, opts.fixed ?? 0.50,
      opts.feeModel ?? 'flat', opts.mdr ?? null, opts.settlement ?? null]);
  const ws = (await pool.query(
    "INSERT INTO workspaces(organization_id,name,currency) VALUES($1,'W','EUR') RETURNING id", [org])).rows[0].id;
  await pool.query(
    "INSERT INTO commission_rules(workspace_id,creator_split_pct,agency_split_pct,chatter_pct,effective_from) VALUES($1,70,20,$2,'-infinity')",
    [ws, opts.chatterPct ?? 10]);
  const creator = (await pool.query(
    "INSERT INTO creators(workspace_id,stage_name,revenue_model,revenue_split_pct) VALUES($1,'Ava',$2,$3) RETURNING id",
    [ws, opts.revenueModel ?? 'revshare', opts.split ?? 70])).rows[0].id;
  const customer = (await pool.query(
    "INSERT INTO customers(workspace_id,creator_id,alias,segment) VALUES($1,$2,'w','vip') RETURNING id", [ws, creator])).rows[0].id;
  return { org, ws, creator, customer };
}

async function postSale(f, gross, extra = {}) {
  const tx = (await pool.query(
    `INSERT INTO transactions(workspace_id,creator_id,customer_id,attributed_membership_id,
       type,status,gross,net,currency,surcharge,provider_transaction_id)
     VALUES($1,$2,$3,$4,'payment','approved',$5,$5,'EUR',$6,$7) RETURNING id`,
    [f.ws, f.creator, f.customer, extra.membershipId ?? null, gross,
      extra.surcharge ?? 0, 'tx-' + Math.random()])).rows[0].id;
  await pool.query('SELECT fn_post_sale($1)', [tx]);
  return (await pool.query('SELECT * FROM commission_entries WHERE transaction_id=$1', [tx])).rows[0];
}

test.after(() => pool.end());

// ── Fee models ───────────────────────────────────────────────────────────────

test('FLAT model applies every percentage to the original gross', async () => {
  const f = await fixture({ feeModel: 'flat', pspRate: 8, fixed: 0.50, margin: 0 });
  const cost = n((await pool.query('SELECT psp_cost($1,100,now()) c', [f.org])).rows[0].c);
  assert.equal(cost, 8.50, '8% of 100 + 0.50');
});

test('CASCADE model applies each fee to the running balance, in order', async () => {
  const f = await fixture({ feeModel: 'cascade', mdr: 7, settlement: 1, fixed: 0.50, margin: 0 });
  const cost = n((await pool.query('SELECT psp_cost($1,100,now()) c', [f.org])).rows[0].c);
  // 100 -7% = 93.00 -0.50 = 92.50 -1% = 91.575  =>  cost 8.425
  assert.equal(cost, 8.425);
});

test('cascade and flat differ, and the difference is real money', async () => {
  const flat = await fixture({ feeModel: 'flat', pspRate: 8, fixed: 0.50, margin: 0 });
  const casc = await fixture({ feeModel: 'cascade', mdr: 7, settlement: 1, fixed: 0.50, margin: 0 });
  const a = n((await pool.query('SELECT psp_cost($1,100,now()) c', [flat.org])).rows[0].c);
  const b = n((await pool.query('SELECT psp_cost($1,100,now()) c', [casc.org])).rows[0].c);
  assert.equal(Math.round((a - b) * 1000) / 1000, 0.075, 'per 100 of volume');
});

// ── Fee itemisation ──────────────────────────────────────────────────────────

test('every fee component is recorded separately', async () => {
  const f = await fixture({ feeModel: 'cascade', mdr: 7, settlement: 1, fixed: 0.50, margin: 5 });
  const e = await postSale(f, 100, { surcharge: 2 });
  assert.equal(n(e.fee_mdr), 7.00);
  assert.equal(n(e.fee_fixed), 0.50);
  assert.equal(n(e.fee_settlement), 0.925, 'settlement lands on the post-fixed balance');
  assert.equal(n(e.platform_margin), 5.00, 'our margin is a plain % of the deal, never cascaded');
  assert.equal(n(e.fee_surcharge), 2.00, 'surcharge is revenue, tracked separately');
});

test('the surcharge never reduces what is distributable', async () => {
  const f = await fixture({ feeModel: 'cascade', mdr: 7, settlement: 1, fixed: 0.50, margin: 5 });
  const withEc = await postSale(f, 100, { surcharge: 2 });
  const without = await postSale(f, 100, { surcharge: 0 });
  assert.equal(n(withEc.distributable), n(without.distributable));
});

// ── Payout waterfall ─────────────────────────────────────────────────────────

test('splits reconcile exactly and nothing is lost', async () => {
  const f = await fixture({ feeModel: 'cascade', mdr: 7, settlement: 1, fixed: 0.50, margin: 5 });
  const e = await postSale(f, 100);
  const parts = n(e.creator_amount) + n(e.chatter_amount) + n(e.agency_amount);
  assert.ok(Math.abs(parts - n(e.distributable)) < 1e-9, 'splits sum to distributable');
  assert.ok(Math.abs(n(e.platform_fee) + n(e.distributable) - n(e.gross)) < 1e-9, 'fee + distributable = gross');
});

test('a €100 deal splits to the documented figures', async () => {
  const f = await fixture({ feeModel: 'cascade', mdr: 7, settlement: 1, fixed: 0.50, margin: 5, split: 70, chatterPct: 10 });
  const e = await postSale(f, 100);
  // Fees are itemised to four decimals, but everything paid out is whole cents:
  // PSP 8.425 + HigherPays 5.00 = 13.425 → 13.43 taken, 86.57 to distribute.
  assert.equal(n(e.platform_fee), 13.43);
  assert.equal(n(e.distributable), 86.57);
  assert.equal(n(e.creator_amount), 60.60, '70% of 86.57, rounded');
  assert.equal(n(e.chatter_amount), 8.66, '10% of 86.57, rounded');
  assert.equal(n(e.agency_amount), 17.31, 'the agency takes the remainder');
});

test('salary and AI creators take no per-sale share', async () => {
  for (const model of ['salary', 'ai']) {
    const f = await fixture({ revenueModel: model, feeModel: 'flat', pspRate: 8, fixed: 0.50, margin: 5 });
    const e = await postSale(f, 100);
    assert.equal(n(e.creator_amount), 0, model);
    assert.ok(n(e.agency_amount) > 0, `${model}: agency keeps the distributable`);
  }
});

test("a chatter's own commission rate overrides the workspace rule", async () => {
  const f = await fixture({ feeModel: 'flat', pspRate: 8, fixed: 0.50, margin: 0, chatterPct: 10 });
  const u = (await pool.query(
    "INSERT INTO users(email,password_hash,full_name) VALUES($1,'x','Sam') RETURNING id",
    ['sam' + Math.random() + '@x.com'])).rows[0].id;
  const m = (await pool.query(
    "INSERT INTO memberships(workspace_id,user_id,role,status,commission_pct) VALUES($1,$2,'chatter','active',25) RETURNING id",
    [f.ws, u])).rows[0].id;
  const e = await postSale(f, 100, { membershipId: m });
  const expected = Math.round(n(e.distributable) * 0.25 * 100) / 100;
  assert.equal(n(e.chatter_amount), expected, '25%, not the workspace default 10%');
});

// ── Reversals ────────────────────────────────────────────────────────────────

test('a refund reverses the sale and charges the refund fee to the right party', async () => {
  const f = await fixture({ feeModel: 'flat', pspRate: 8, fixed: 0.50, margin: 5 });
  await pool.query(
    "INSERT INTO settlement_fee_config(organization_id,chargeback_fee,refund_fee,effective_from) VALUES($1,60,15,'-infinity')",
    [f.org]);
  const sale = await postSale(f, 100);
  await pool.query('SELECT fn_post_refund($1)', [sale.transaction_id]);
  const net = (await pool.query(
    `SELECT SUM(creator_amount) c, SUM(chatter_amount) ch, SUM(agency_amount) a
       FROM commission_entries WHERE transaction_id=$1`, [sale.transaction_id])).rows[0];
  assert.equal(n(net.ch), 0, 'chatter always loses the commission');
  assert.ok(Math.abs(n(net.c) + 15) < 1e-9, 'rev-share creator bears the refund fee');
  assert.equal(n(net.a), 0, 'agency back to zero');
});

test('a transaction cannot be reversed twice', async () => {
  const f = await fixture({ feeModel: 'flat', pspRate: 8, fixed: 0.50, margin: 5 });
  await pool.query(
    "INSERT INTO settlement_fee_config(organization_id,chargeback_fee,refund_fee,effective_from) VALUES($1,60,15,'-infinity')",
    [f.org]);
  const sale = await postSale(f, 100);
  await pool.query('SELECT fn_post_refund($1)', [sale.transaction_id]);
  await assert.rejects(
    () => pool.query('SELECT fn_post_chargeback($1)', [sale.transaction_id]), /already reversed/);
});

// ── Effective-dated rates ────────────────────────────────────────────────────

test('rate changes do not re-price historical transactions', async () => {
  const f = await fixture({ feeModel: 'flat', pspRate: 8, fixed: 0.50, margin: 5 });
  const before = await postSale(f, 100);
  await pool.query(
    `INSERT INTO platform_fee_rates(organization_id, psp_rate_pct, margin_rate_pct, psp_fixed_fee, fee_model, effective_from)
     VALUES ($1, 12, 9, 1.00, 'flat', now())`, [f.org]);
  const still = (await pool.query('SELECT platform_fee FROM commission_entries WHERE id=$1', [before.id])).rows[0];
  assert.equal(n(still.platform_fee), n(before.platform_fee), 'the old entry is untouched');
});
