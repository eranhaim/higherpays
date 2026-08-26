'use strict';
// Marks a payment link as paid, for the demo. Posts a correctly signed MantaPay
// notification to the workspace's webhook, so the payment travels the real
// production path: payment + transaction rows, the revenue split, the
// notification fan-out, and the link moving to "details needed".
//
//   cd backend
//   node scripts/demo-pay.js ord_ab12cd34
//   node scripts/demo-pay.js ord_ab12cd34 --decline
//
// The reference is the "Ref" column on the Payment links page. Reads the
// database directly (DATABASE_URL) and posts through the console's own API
// (DEMO_API, default http://localhost:8083/api).
const crypto = require('crypto');
const { pool } = require('../src/db');
const sig = require('../src/providers/mantapay-signature');
const config = require('../src/config');

const reference = process.argv[2];
const declined = process.argv.includes('--decline');
const API = (process.env.DEMO_API || 'http://localhost:8083/api').replace(/\/$/, '');

if (!reference) {
  console.error('usage: node scripts/demo-pay.js <link-reference> [--decline]');
  process.exit(1);
}

async function main() {
  const link = (await pool.query(
    `SELECT pl.reference_id, pl.amount, pl.currency, pl.status, w.webhook_endpoint_id, w.merchant_id, w.provider_config_ref
       FROM payment_links pl JOIN workspaces w ON w.id = pl.workspace_id
      WHERE pl.reference_id = $1`, [reference])).rows[0];
  if (!link) throw new Error(`no payment link with reference ${reference}`);
  if (link.status !== 'active') throw new Error(`link is ${link.status}, not active`);

  const hashKey = (link.provider_config_ref && process.env[link.provider_config_ref]) || config.mantapayHashKey;
  if (!hashKey) throw new Error('no MantaPay hash key configured (MANTAPAY_HASH_KEY)');

  const fields = {
    trans_id: 'demo_' + crypto.randomBytes(5).toString('hex'),
    trans_order: link.reference_id,
    reply_code: declined ? '051' : '000',
    reply_desc: declined ? 'Declined' : 'Approved',
    trans_amount: String(Number(link.amount)),
    trans_currency: link.currency,
    merchant_id: link.merchant_id || config.mantapayMerchantId || '',
    trans_date: new Date().toLocaleString('en-GB').replace(',', ''),
    client_email: 'demo.buyer@example.com',
  };
  // The notification signs a subset, in this order.
  fields.signature = sig.digest(
    fields.trans_id + fields.trans_order + fields.reply_code + fields.trans_amount + fields.trans_currency + hashKey);

  const res = await fetch(`${API}/webhooks/payment/${link.webhook_endpoint_id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`webhook returned ${res.status}: ${JSON.stringify(body)}`);

  console.log(`${declined ? 'Declined' : 'Paid'} ${fields.trans_amount} ${fields.trans_currency} on ${reference}`);
  console.log(declined
    ? 'The link stays active, so the customer can try again.'
    : 'Open Payments — it is waiting for an agent to complete the customer and category.');
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => pool.end());
